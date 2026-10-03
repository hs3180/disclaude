"""Durable ownership and run identities. No credentials or harness IDs."""

from __future__ import annotations

import json
import fcntl
import os
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path

ACTIVE = ("queued", "running", "input_required", "stopping")
TERMINAL = ("completed", "failed", "cancelled", "unknown")


class Ledger:
    def __init__(self, path: str):
        location = Path(path)
        location.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        # Open an owned state file before SQLite can create a permissive one.
        self.lock_fd = os.open(str(location) + ".owner.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            os.close(self.lock_fd)
            raise RuntimeError("Notebook ledger already has a server writer") from None
        self.db = None
        self.closed = False
        try:
            fd = os.open(location, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            os.close(fd)
            os.chmod(location, 0o600)
            self.db = sqlite3.connect(location, isolation_level=None)
            self.db.row_factory = sqlite3.Row
            application_id = self.db.execute("PRAGMA application_id").fetchone()[0]
            schema_version = self.db.execute("PRAGMA user_version").fetchone()[0]
            tables = self.db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
            if (application_id not in (0, 0x444A5031) or schema_version not in (0, 2)
                    or (tables and (application_id != 0x444A5031 or schema_version != 2))):
                raise RuntimeError("unsupported Notebook ledger schema; preserve state for explicit migration")
            self.db.execute("PRAGMA journal_mode=DELETE")
            self.db.execute("PRAGMA synchronous=FULL")
            self.db.execute("PRAGMA foreign_keys=ON")
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS controllers (
                    document_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
                    generation INTEGER NOT NULL, principal TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS paused_controllers (
                    document_id TEXT PRIMARY KEY, generation INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS kernels (
                    document_id TEXT PRIMARY KEY, kernel_id TEXT NOT NULL UNIQUE,
                    incarnation TEXT NOT NULL, process_id INTEGER NOT NULL, server_boot TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY, document_id TEXT NOT NULL,
                    request_id TEXT NOT NULL UNIQUE, kernel_id TEXT NOT NULL,
                    target TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL,
                    stage TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS runs_document ON runs(document_id, state);
                PRAGMA application_id=1145720881;
                PRAGMA user_version=2;
            """)
            self.db.execute(
                "INSERT OR IGNORE INTO settings VALUES ('server_namespace', ?)",
                (str(uuid.uuid4()),),
            )
            self.namespace = self.db.execute(
                "SELECT value FROM settings WHERE name='server_namespace'"
            ).fetchone()[0]
            self.boot = str(uuid.uuid4())
            # A new server has no proof that an interrupted send did or did not run.
            # Do not replay even a previously queued request after a process restart.
            with self.transaction():
                unfinished = self.db.execute(
                    "SELECT run_id, details FROM runs WHERE state IN "
                    "('queued','running','input_required','stopping')"
                ).fetchall()
                for row in unfinished:
                    details = json.loads(row["details"]) | {
                        "reason": "server_restarted; original execution requires reconciliation",
                        "outputCommit": "stale", "kernelMemory": "unknown", "recoveryRequired": True,
                    }
                    self.db.execute(
                        "UPDATE runs SET state='unknown',stage='recovery',details=?,updated_at=CURRENT_TIMESTAMP "
                        "WHERE run_id=?", (json.dumps(details, ensure_ascii=False), row["run_id"]),
                    )

        except BaseException:
            if self.db is not None:
                self.db.close()
            os.close(self.lock_fd)
            self.closed = True
            raise

    @contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        else:
            self.db.execute("COMMIT")

    def controller(self, document_id: str):
        row = self.db.execute(
            "SELECT owner_id, generation, principal FROM controllers WHERE document_id=?",
            (document_id,),
        ).fetchone()
        return dict(row) if row else None

    def paused(self, document_id: str) -> bool:
        current = self.controller(document_id)
        row = self.db.execute("SELECT generation FROM paused_controllers WHERE document_id=?",
                              (document_id,)).fetchone()
        return bool(current and row and row[0] == current["generation"])

    def owns(self, document_id: str, controller: dict, principal: str, *, allow_paused=False) -> bool:
        current = self.controller(document_id)
        return bool(current and current["owner_id"] == controller.get("ownerId")
                    and current["generation"] == controller.get("generation")
                    and current["principal"] == principal
                    and (allow_paused or not self.paused(document_id)))

    def pause(self, document_id: str, controller: dict, principal: str):
        if not self.owns(document_id, controller, principal, allow_paused=True):
            raise ValueError("controller generation changed")
        self.db.execute("INSERT INTO paused_controllers VALUES (?,?) ON CONFLICT(document_id) "
                        "DO UPDATE SET generation=excluded.generation",
                        (document_id, controller["generation"]))

    def claim(self, document_id: str, owner_id: str, principal: str, expected: int):
        current = self.controller(document_id)
        generation = current["generation"] if current else 0
        if generation != expected:
            raise ValueError("controller generation changed")
        if (current and current["owner_id"] == owner_id and current["principal"] == principal
                and not self.paused(document_id)):
            return {"ownerId": owner_id, "generation": generation}
        if generation >= 9007199254740991:
            raise ValueError("controller generation exhausted")
        generation += 1
        self.db.execute(
            "INSERT INTO controllers VALUES (?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET "
            "owner_id=excluded.owner_id,generation=excluded.generation,principal=excluded.principal",
            (document_id, owner_id, generation, principal),
        )
        self.db.execute("DELETE FROM paused_controllers WHERE document_id=?", (document_id,))
        return {"ownerId": owner_id, "generation": generation}

    def run(self, run_id: str):
        row = self.db.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["target"] = json.loads(result["target"])
        result["details"] = json.loads(result["details"])
        return result

    def request(self, request_id: str):
        row = self.db.execute("SELECT run_id FROM runs WHERE request_id=?", (request_id,)).fetchone()
        return self.run(row[0]) if row else None

    def active(self, document_id: str):
        return [self.run(row[0]) for row in self.db.execute(
            "SELECT run_id FROM runs WHERE document_id=? AND state IN "
            "('queued','running','input_required','stopping') ORDER BY created_at,rowid", (document_id,)
        )]

    def insert(self, target: dict, source: str, request_id: str, principal: str):
        self.db.execute(
            "INSERT INTO runs(run_id,document_id,request_id,kernel_id,target,source,state,stage,details) "
            "VALUES(?,?,?,?,?,?,'queued','recorded',?)",
            (target["runId"], target["notebook"]["identity"]["documentId"], request_id,
             target["kernelId"], json.dumps(target, ensure_ascii=False), source,
             json.dumps({"principal": principal, "outputs": [], "outputCommit": "pending"})),
        )

    def update(self, run_id: str, *, state: str | None = None, stage: str | None = None,
               details: dict | None = None):
        current = self.run(run_id)
        if not current:
            raise ValueError("unknown run")
        self.db.execute(
            "UPDATE runs SET state=?,stage=?,details=?,updated_at=CURRENT_TIMESTAMP WHERE run_id=?",
            (state or current["state"], stage or current["stage"],
             json.dumps(current["details"] | (details or {}), ensure_ascii=False), run_id),
        )

    def close(self):
        if not self.closed:
            self.closed = True
            try:
                self.db.close()
            finally:
                os.close(self.lock_fd)

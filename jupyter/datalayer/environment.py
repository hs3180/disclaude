"""Reversible file installation; imported Server code activates on an external restart."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import tempfile

import configure
from discovery import discover
import install


class EnvironmentError(RuntimeError):
    pass


def fingerprint(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def atomic(path: Path, data: bytes, mode: int = 0o600, owner=None) -> None:
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(data)
    try:
        temporary.chmod(mode)
        if owner and os.geteuid() == 0:
            os.chown(temporary, *owner)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def save(state: Path, plan: dict) -> None:
    atomic(state / "plan.json", (json.dumps(plan, indent=2) + "\n").encode())


def current_hash(path: Path):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise EnvironmentError("Deployment target is no longer a regular file")
    return fingerprint(path.read_bytes()) if path.exists() else None


def verify(plan: dict, state: Path) -> list[str]:
    positions = []
    for item in plan["files"]:
        for field in ("original", "candidate"):
            filename = item.get(field)
            if filename:
                path = state / filename
                if path.is_symlink() or current_hash(path) != item[field + "Sha256"]:
                    raise EnvironmentError("Saved patch/rollback file changed; transition refused")
        actual = current_hash(Path(item["target"]))
        if actual == item["originalSha256"] == item["candidateSha256"]:
            positions.append("unchanged")
        elif actual == item["originalSha256"]:
            positions.append("original")
        elif actual == item["candidateSha256"]:
            positions.append("candidate")
        else:
            raise EnvironmentError("Installed package/config changed outside this deployment; transition refused")
    return positions


def prepare(root: Path, manifest_sha: str, state: Path, target: dict) -> dict:
    state.mkdir(parents=True, exist_ok=True)
    if state.is_symlink():
        raise EnvironmentError("Refuse a symlinked state directory")
    state.chmod(0o700)
    if (state / "plan.json").exists():
        plan = json.loads((state / "plan.json").read_text())
        if plan.get("deployment") != "environment" or plan["manifestSha256"] != manifest_sha or plan["target"] != target or plan.get("service"):
            raise EnvironmentError("State belongs to another patch/environment")
        verify(plan, state)
        return plan
    roots = {"python": Path(target["packageDir"]), "frontend": Path(target["frontendDir"])}
    writes, unchanged = install.plan_files(root, roots)
    if unchanged:
        raise EnvironmentError("Environment is already partially/patched; original rollback must come from its existing state")
    config = Path(target["configFile"])
    policy = json.loads((root / "server-config.json").read_text())
    writes = [*writes, (roots["python"] / "disclaude-repair.json", install.marker(root)),
              (config, configure.configured_bytes(config, policy))]
    if len({str(path) for path, _ in writes}) != len(writes):
        raise EnvironmentError("Configuration and patch targets overlap")
    # Check all targets before staging. Preparation never creates install/config
    # directories or writes into the running environment.
    for path, _ in writes:
        current_hash(path)
        parent = path.parent
        while not parent.exists():
            parent = parent.parent
        if not os.access(parent, os.W_OK):
            raise EnvironmentError("Target directory is not writable by this login; use its deployment owner")
        if path.exists() and path.stat().st_uid != os.geteuid() and os.geteuid() != 0:
            raise EnvironmentError("Target file is owned by another user; use its deployment owner")
    plan = {"schema": 2, "deployment": "environment", "manifestSha256": manifest_sha,
            "target": target, "files": [], "phase": "prepared"}
    for index, (path, data) in enumerate(writes):
        before = path.read_bytes() if path.exists() else None
        original = f"original-{index}" if before is not None else None
        candidate = f"candidate-{index}"
        if original:
            atomic(state / original, before)
        atomic(state / candidate, data)
        stat = path.stat() if before is not None else None
        plan["files"].append({"target": str(path), "original": original, "candidate": candidate,
                              "originalSha256": fingerprint(before) if before is not None else None,
                              "candidateSha256": fingerprint(data), "mode": stat.st_mode & 0o777 if stat else 0o644,
                              "owner": [stat.st_uid, stat.st_gid] if stat else None})
    verify(plan, state)
    save(state, plan)
    return plan


def activation() -> dict:
    return {"activation": "server_restart_required", "serverRestartRequired": True,
            "labRefreshRequired": True, "runningCodeVerified": False}


def transition(plan: dict, state: Path, action: str) -> dict:
    if plan.get("deployment") != "environment" or plan.get("service"):
        raise EnvironmentError("State belongs to another installation")
    positions = verify(plan, state)
    expected = "candidate" if action == "apply" else "original"
    complete = all(position in (expected, "unchanged") for position in positions)
    finished = "applied" if action == "apply" else "rolled_back"
    if complete and plan["phase"] == finished:
        return {"action": action, "changed": False, "state": str(state), "phase": finished,
                **activation()}
    # Install on disk only. Already imported Server objects are deliberately
    # left alone; the caller restarts Jupyter with its existing manager.
    plan["phase"] = action + "_requested"
    save(state, plan)
    for item in plan["files"]:
        path = Path(item["target"])
        if expected == "original" and item["original"] is None:
            path.unlink(missing_ok=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            atomic(path, (state / item[expected]).read_bytes(), item["mode"], item["owner"])
    if any(position not in (expected, "unchanged") for position in verify(plan, state)):
        raise EnvironmentError("Installed files could not be verified; inspect the saved state")
    plan["phase"] = finished
    save(state, plan)
    return {"action": action, "changed": not complete, "state": str(state), "phase": finished,
            **activation()}


def status(plan: dict, state: Path) -> dict:
    positions = verify(plan, state)
    return {"deployment": "environment", "phase": plan["phase"], "state": str(state),
            "files": positions, "target": plan["target"], "applicationVerified": False,
            **(activation() if plan["phase"] != "prepared" else
               {"activation": "not_installed", "serverRestartRequired": False})}

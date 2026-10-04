"""RTC access and bounded room leases for the explicitly pinned server stack.

The native room lock and manual-save hook are intentionally isolated here.
This extension refuses unverified RTC versions instead of guessing their API.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from contextlib import asynccontextmanager
from collections import OrderedDict
from dataclasses import dataclass

from jupyter_core.utils import ensure_async
from pycrdt import Text
from tornado.web import HTTPError


def source_hash(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def revision(document) -> str:
    # Native CRDT client IDs can change on a cold load without a Notebook edit.
    # CAS covers the whole canonical Notebook, including metadata and outputs,
    # while excluding room bookkeeping such as dirty/awareness/client IDs.
    content = json.dumps(document.get(deduplicate=False), ensure_ascii=False,
                         sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(content.encode("utf-8")).hexdigest()


def cell(document, cell_id: str):
    matches = [value for value in document.ycells if value.get("id") == cell_id]
    if len(matches) != 1:
        raise HTTPError(409 if matches else 404, reason="cell identity absent or ambiguous")
    return matches[0]


class RoomPeer:
    """A real passive native Channel; no awareness identity or document writes."""

    def __init__(self, path: str):
        self.path = path
        self.ready = asyncio.Event()
        self.closed = asyncio.Event()

    async def send(self, message: bytes):
        self.ready.set()

    def __aiter__(self):
        return self

    async def __anext__(self):
        await self.closed.wait()
        raise StopAsyncIteration


@dataclass
class RoomLease:
    document_id: str
    document: object
    room: object
    peer: RoomPeer
    task: asyncio.Task
    references: int = 0
    cleaner: asyncio.Task | None = None


class Documents:
    def __init__(self, rtc, file_ids, contents, ledger, *, idle_seconds: float = 60,
                 max_rooms: int = 16):
        self.rtc = rtc
        self.file_ids = file_ids
        self.contents = contents
        self.ledger = ledger
        self.idle_seconds = idle_seconds
        self.max_rooms = max_rooms
        self.leases: dict[str, RoomLease] = {}
        self.locks: dict[str, asyncio.Lock] = {}
        self.lock_users: dict[str, int] = {}
        self.pending_rooms: set[str] = set()
        self.cleanup_errors: OrderedDict[str, str] = OrderedDict()

    @asynccontextmanager
    async def locked(self, document_id: str):
        lock = self.locks.setdefault(document_id, asyncio.Lock())
        self.lock_users[document_id] = self.lock_users.get(document_id, 0) + 1
        try:
            async with lock:
                yield
        finally:
            self.lock_users[document_id] -= 1
            if not self.lock_users[document_id] and document_id not in self.leases:
                self.lock_users.pop(document_id)
                self.locks.pop(document_id)

    def cleanup_failed(self, document_id: str, error: Exception):
        self.cleanup_errors[document_id] = str(error)[:500]
        self.cleanup_errors.move_to_end(document_id)
        while len(self.cleanup_errors) > self.max_rooms:
            self.cleanup_errors.popitem(last=False)

    def locate(self, notebook: dict):
        identity = notebook.get("identity", {})
        if identity.get("serverNamespace") != self.ledger.namespace:
            raise HTTPError(409, reason="Jupyter service namespace mismatch")
        document_id = identity.get("documentId")
        if not isinstance(document_id, str) or not document_id:
            raise HTTPError(400, reason="stable documentId required")
        connection_id = identity.get("connectionId")
        if not isinstance(connection_id, str) or not connection_id:
            raise HTTPError(400, reason="connectionId required")
        path = self.file_ids.get_path(document_id)
        if path is None:
            raise HTTPError(404, reason="Notebook document no longer exists")
        requested_path = notebook.get("contentPath")
        indexed = self.file_ids.get_id(requested_path) if isinstance(requested_path, str) else None
        if indexed is not None and indexed != document_id:
            raise HTTPError(409, reason="path now belongs to another Notebook")
        return {"identity": dict(identity), "contentPath": path}

    async def open(self, path: str, connection_id: str):
        model = await ensure_async(self.contents.get(path, content=False))
        if model["type"] != "notebook":
            raise HTTPError(400, reason="resource is not a Notebook")
        document_id = self.file_ids.index(path)
        if document_id is None:
            raise HTTPError(404, reason="Notebook could not be indexed")
        return {"identity": {"connectionId": connection_id, "serverNamespace": self.ledger.namespace,
                             "documentId": document_id}, "contentPath": path}

    async def acquire(self, notebook: dict):
        locator = self.locate(notebook)
        document_id = locator["identity"]["documentId"]
        async with self.locked(document_id):
            entry = self.leases.get(document_id)
            if entry is None:
                if len(self.leases) + len(self.pending_rooms) >= self.max_rooms:
                    raise HTTPError(429, reason="active Notebook room limit reached")
                self.pending_rooms.add(document_id)
                try:
                    document = await self.rtc.get_document(
                        path=locator["contentPath"], content_type="notebook", file_format="json",
                        copy=False, create=True,
                    )
                    if document is None:
                        raise HTTPError(503, reason="shared Notebook unavailable")
                    room_id = "json:notebook:" + document_id
                    async with self.rtc._room_locks[room_id]:
                        room = await self.rtc.ywebsocket_server.get_room(room_id)
                        if room.cleaner is not None:
                            room.cleaner.cancel()
                            room.cleaner = None
                        peer = RoomPeer(room_id)
                        task = asyncio.create_task(room.serve(peer))
                        try:
                            await asyncio.wait_for(peer.ready.wait(), 3)
                        except BaseException:
                            peer.closed.set()
                            await task
                            raise
                        entry = RoomLease(document_id, document, room, peer, task)
                        self.leases[document_id] = entry
                finally:
                    self.pending_rooms.discard(document_id)
            if entry.cleaner is not None:
                entry.cleaner.cancel()
                entry.cleaner = None
            entry.references += 1
            return entry, locator

    def release(self, entry: RoomLease):
        entry.references -= 1
        if entry.references < 0:
            raise RuntimeError("unbalanced Notebook room lease")
        if entry.references == 0:
            entry.cleaner = asyncio.create_task(self._expire(entry))

    @asynccontextmanager
    async def access(self, notebook: dict):
        entry, locator = await self.acquire(notebook)
        try:
            yield entry, locator
        finally:
            self.release(entry)

    async def _expire(self, entry: RoomLease, retry: bool = False):
        try:
            await asyncio.sleep(max(1, self.idle_seconds) if retry else self.idle_seconds)
            async with self.locked(entry.document_id):
                if entry.references or self.leases.get(entry.document_id) is not entry:
                    return
                try:
                    await self.save(entry)
                except Exception as error:
                    # Keep unsaved authoritative state pinned and visible while
                    # bounded retries await a successful native save.
                    self.cleanup_failed(entry.document_id, error)
                    entry.cleaner = asyncio.create_task(self._expire(entry, retry=True))
                    return
                self.cleanup_errors.pop(entry.document_id, None)
                entry.peer.closed.set()
                await entry.task
                del self.leases[entry.document_id]
                # Human peers retain their room. With no peers, save completed
                # before native room/loader cleanup; a future access cold-loads.
                room_id = entry.peer.path
                async with self.rtc._room_locks[room_id]:
                    if not entry.room.clients:
                        if entry.room.cleaner is not None:
                            entry.room.cleaner.cancel()
                            entry.room.cleaner = None
                        await self.rtc.ywebsocket_server.delete_room(room=entry.room)
                        loader = self.rtc.file_loaders[entry.document_id]
                        if loader.number_of_subscriptions == 0:
                            await self.rtc.file_loaders.remove(entry.document_id)
        except asyncio.CancelledError:
            return
        except Exception as error:
            self.cleanup_failed(entry.document_id, error)

    async def save(self, entry: RoomLease):
        # The upstream manual-save task swallows errors. Check dirty/hash after
        # it completes; callers additionally verify their exact saved output.
        task = entry.room._save_to_disc()
        if task is None:
            raise HTTPError(503, reason="shared document update prevents save")
        await task
        if entry.document.dirty:
            raise HTTPError(503, reason="Notebook save is not confirmed")

    @staticmethod
    def snapshot(entry: RoomLease, locator: dict, cell_id: str):
        selected = cell(entry.document, cell_id)
        source = str(selected["source"])
        return {"notebook": locator, "cellId": cell_id, "revision": revision(entry.document),
                "sourceHash": source_hash(source), "source": source}

    async def read(self, notebook: dict, cell_id: str):
        async with self.access(notebook) as (entry, locator):
            return self.snapshot(entry, locator, cell_id)

    async def edit(self, request: dict, principal: str):
        async with self.access(request["notebook"]) as (entry, locator):
            # No await between version/authority checks and the CRDT mutation.
            with self.ledger.transaction():
                if not self.ledger.owns(entry.document_id, request["controller"], principal):
                    current = self.ledger.controller(entry.document_id)
                    return {"state": "ownership_lost", "currentGeneration": current["generation"]
                            if current else 0}
                snapshot = self.snapshot(entry, locator, request["cellId"])
                if (snapshot["revision"] != request["expectedRevision"] or
                        snapshot["sourceHash"] != request["expectedSourceHash"]):
                    return {"state": "conflict", "current": snapshot}
                selected = cell(entry.document, request["cellId"])
                with entry.document.ydoc.transaction():
                    source = selected["source"]
                    if not isinstance(source, Text):
                        raise HTTPError(409, reason="cell source is not shared Text")
                    del source[:]
                    source += request["source"]
                return {"state": "applied", "snapshot": self.snapshot(entry, locator, request["cellId"])}

    async def close(self):
        entries = list(self.leases.values())
        cleaners = [entry.cleaner for entry in entries if entry.cleaner is not None]
        for cleaner in cleaners:
            cleaner.cancel()
        await asyncio.gather(*cleaners, return_exceptions=True)
        errors = []
        for entry in entries:
            try:
                await self.save(entry)
            except Exception as error:
                errors.append(error)
            finally:
                entry.peer.closed.set()
                try:
                    await entry.task
                except Exception as error:
                    errors.append(error)
        self.leases.clear()
        self.locks.clear()
        self.lock_users.clear()
        if errors:
            raise ExceptionGroup("Notebook shutdown has unconfirmed saves", errors)

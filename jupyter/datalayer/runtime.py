"""Bounded request retention and dispatch state for the nbmodel 0.2.9 repair.

This module is installed into jupyter_server_nbmodel by the verified overlay;
it is not a separate Jupyter extension or execution service.
"""

from __future__ import annotations

import asyncio
import copy
import json
import time
import typing as t
from dataclasses import dataclass, field

from jupyter_core.utils import ensure_async


class ResultQuotaExceeded(RuntimeError):
    """Unexpired or active requests fill the configured result quota."""


class ResultExpired(ValueError):
    """A retained result expired; this says nothing about whether it executed."""


class TargetChanged(ValueError):
    """The original kernel process can no longer be verified."""


@dataclass
class ExecutionControl:
    """Serialize target interruption with completion and the next dispatch."""

    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    active_id: str | None = None
    needs_ready: bool = False
    incarnation: str | None = None
    kernel_pid: int | None = None
    phase: str = "idle"
    cancelled_id: str | None = None
    quarantined: bool = False
    display_targets: dict[str, list] = field(default_factory=dict)


@dataclass
class DisplayTarget:
    context: t.Any
    output: dict
    index: int | None


class OutputContext:
    """Write only into the original stable cell/source, retaining run history."""

    provenance_key = "jupyter_server_nbmodel_provenance"

    def __init__(self, notebook: t.Any, source: str, metadata: dict, registry: dict, progress: dict | None = None):
        self.notebook = notebook
        self.source = source
        self.metadata = metadata
        self.registry = registry
        self.stale = False
        self.bound = notebook is not None
        self.output_version = 0
        self.progress = progress
        self.source_subscription = None
        self.observed_source = None

    def _cell(self):
        if self.notebook is None:
            return None
        matches = [cell for cell in self.notebook.ycells if cell["id"] == self.metadata.get("cell_id")]
        return matches[0] if len(matches) == 1 else None

    def _owns(self, cell) -> bool:
        if cell is None:
            return False
        metadata = cell["metadata"]
        marker = metadata.get("jupyter_server_nbmodel") or metadata.get(self.provenance_key) or {}
        return marker.get("requestId") == self.metadata.get("request_id")

    def provenance(self, source_matches: bool) -> dict:
        return {"requestId": self.metadata.get("request_id"),
                "kernelId": self.metadata.get("kernel_id"),
                "kernelIncarnation": self.metadata.get("kernel_incarnation"),
                "sourceHash": self.metadata.get("source_hash"),
                "outputVersion": self.output_version,
                "sourceMatches": source_matches,
                "resultState": "current" if source_matches else "historical"}

    def begin(self):
        cell = self._cell()
        if cell is None or str(cell["source"]) != self.source:
            self.stale = self.bound
            return None
        self.forget_displays()
        with cell.doc.transaction():
            cell["metadata"][self.provenance_key] = self.provenance(True)
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is not None:
            self.observed_source = cell["source"]
            self.source_subscription = self.observed_source.observe(
                lambda event: loop.call_soon(self.cell_for_output))
        return cell

    def bump_output_version(self) -> None:
        self.output_version += 1
        if self.progress is not None:
            self.progress["output_version"] = self.output_version
        cell = self.cell_for_output()
        if cell is not None:
            with cell.doc.transaction():
                cell["metadata"][self.provenance_key] = self.provenance(True)

    def cell_for_output(self):
        cell = self._cell()
        if not self.stale and self._owns(cell) and str(cell["source"]) == self.source:
            return cell
        if self.bound:
            self.stale = True
        if self._owns(cell):
            with cell.doc.transaction():
                del cell["outputs"][:]
                cell["execution_count"] = None
                cell["metadata"][self.provenance_key] = self.provenance(False)
        return None

    def finish(self) -> None:
        if self.source_subscription is not None:
            self.observed_source.unobserve(self.source_subscription)
            self.source_subscription = None
        self.cell_for_output()
        cell = self._cell()
        if self._owns(cell):
            with cell.doc.transaction():
                cell["execution_state"] = "idle"
                if "jupyter_server_nbmodel" in cell["metadata"]:
                    del cell["metadata"]["jupyter_server_nbmodel"]

    def forget_displays(self) -> None:
        for key, targets in list(self.registry.items()):
            kept = [target for target in targets if not (
                target.context.metadata.get("document_id") == self.metadata.get("document_id")
                and target.context.metadata.get("cell_id") == self.metadata.get("cell_id"))]
            if kept:
                self.registry[key] = kept
            else:
                del self.registry[key]

    def display_key(self, display_id: str) -> str:
        return json.dumps([self.metadata.get("document_id"), display_id])

    def register_display(self, display_id: str, output: dict, cell) -> None:
        index = len(cell["outputs"]) - 1 if cell is not None else None
        self.registry.setdefault(self.display_key(display_id), []).append(DisplayTarget(self, output, index))

    def update_display(self, display_id: str, content: dict) -> None:
        kept = []
        for target in self.registry.get(self.display_key(display_id), []):
            target.output["data"] = copy.deepcopy(content.get("data", {}))
            target.output["metadata"] = copy.deepcopy(content.get("metadata", {}))
            cell = target.context.cell_for_output()
            if cell is None or target.index is None or target.index >= len(cell["outputs"]):
                continue
            with cell.doc.transaction():
                cell["outputs"][target.index] = copy.deepcopy(dict(target.output))
                provenance = target.context.provenance(True)
                provenance["displayUpdatedByRequestId"] = self.metadata.get("request_id")
                cell["metadata"][self.provenance_key] = provenance
            kept.append(target)
        if kept:
            self.registry[self.display_key(display_id)] = kept
        else:
            self.registry.pop(self.display_key(display_id), None)


async def kernel_incarnation(client: t.Any) -> str | None:
    """Read the native reply session while this queue owns an idle client."""
    if getattr(client, "_server_nbmodel_remote", False):
        return None
    uid = await ensure_async(client.kernel_info())
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        reply = await ensure_async(client.get_shell_msg(timeout=max(0.1, deadline - time.monotonic())))
        if reply.get("parent_header", {}).get("msg_id") != uid:
            continue
        header = reply.get("header", {})
        value = header.get("session")
        if header.get("msg_type") == "kernel_info_reply" and isinstance(value, str) and 0 < len(value) <= 256:
            return value
        raise RuntimeError("Native kernel incarnation could not be verified")
    raise RuntimeError("Native kernel incarnation could not be verified")


async def cancel_target(
    control: ExecutionControl,
    results: dict,
    uid: str,
    interrupt: t.Callable[[], t.Awaitable[None]],
    current_pid: t.Callable[[], int | None],
) -> None:
    """Cancel only this queued/current request, never another kernel execution."""
    async with control.lock:
        if uid not in results:
            raise ValueError("Unknown original nbmodel request")
        result = results[uid]
        if isinstance(result, dict) and result.get("pending") is not True:
            return
        if control.active_id != uid:
            # The queue worker skips this tombstone without executing its code.
            results[uid] = {"status": "error", "execution_started": False,
                            "error": {"ename": "CancelledError", "evalue": "Queued request cancelled"},
                            "outputs": "[]"}
            return
        if control.phase == "preparing":
            control.cancelled_id = uid
            return
        if control.phase != "running" or control.needs_ready:
            return
        if control.kernel_pid is None or current_pid() != control.kernel_pid:
            raise TargetChanged("Original kernel incarnation changed; target interrupt refused")
        control.needs_ready = True
        try:
            await interrupt()
        except BaseException:
            control.needs_ready = False
            raise


class RetainedResults(dict):
    """Non-consuming terminal snapshots with a TTL and admission quota.

    The quota never evicts an unexpired result. New submissions are refused
    while it is full. Pending requests do not expire. Completed oversized
    payloads are archived through the configured Jupyter Contents manager;
    the API returns an explicit bounded preview and the complete artifact.
    State is process-local: a server restart may lose request lookup, but it
    does not silently replay code or claim that kernel memory survived.
    """

    def __init__(
        self,
        ttl: float,
        max_records: int,
        inline_bytes: int,
        *,
        clock: t.Callable[[], float] = time.monotonic,
        archive: t.Callable[[str, dict], t.Awaitable[str]] | None = None,
    ):
        super().__init__()
        if ttl <= 0 or max_records < 1 or inline_bytes < 1024:
            raise ValueError("Invalid nbmodel request retention policy")
        self.ttl = ttl
        self.max_records = max_records
        self.inline_bytes = inline_bytes
        self.clock = clock
        self.archive = archive
        self.deadlines: dict[str, float] = {}
        # Small bounded tombstones distinguish expiry without retaining output.
        self.expired: dict[str, float] = {}

    def __setitem__(self, uid: str, result: t.Any) -> None:
        super().__setitem__(uid, result)
        if isinstance(result, dict) and result.get("pending") is not True:
            # Never extend retention on GET, DELETE or repeated assignment.
            self.deadlines.setdefault(uid, self.clock() + self.ttl)

    def prune(self) -> list[str]:
        now = self.clock()
        removed = []
        for uid, deadline in list(self.deadlines.items()):
            if deadline <= now:
                self.pop(uid, None)
                del self.deadlines[uid]
                self.expired[uid] = now + self.ttl
                removed.append(uid)
        for uid, deadline in list(self.expired.items()):
            if deadline <= now:
                del self.expired[uid]
        while len(self.expired) > self.max_records:
            del self.expired[next(iter(self.expired))]
        return removed

    def admit(self) -> None:
        self.prune()
        if len(self) >= self.max_records:
            raise ResultQuotaExceeded("nbmodel retained-request quota is full")

    def snapshot(self, uid: str) -> dict:
        self.prune()
        if uid in self.expired:
            raise ResultExpired("Original nbmodel result expired; execution is not disproved")
        return copy.deepcopy(self[uid])

    async def finish(self, uid: str, result: dict) -> dict:
        payload = json.dumps(result, ensure_ascii=False)
        if len(payload.encode("utf-8")) > self.inline_bytes:
            if self.archive is None:
                raise RuntimeError("Oversized nbmodel result requires a configured artifact store")
            artifact = await self.archive(uid, result)
            result = {
                **{k: v for k, v in result.items() if k not in ("outputs", "source")},
                "outputs": "[]",
                "outputs_truncated": True,
                "result_artifact": artifact,
                "result_bytes": len(payload.encode("utf-8")),
            }
        self[uid] = result
        return result

    def progress(self, outputs: list) -> dict:
        """Keep status responses bounded while a complete artifact is pending."""
        payload = json.dumps(outputs, ensure_ascii=False)
        if len(payload.encode("utf-8")) > self.inline_bytes:
            return {"outputs": "[]", "outputs_truncated": True, "result_artifact_pending": True}
        return {"outputs": payload}

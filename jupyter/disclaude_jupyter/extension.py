"""Authenticated server endpoints and the shared JupyterLab Run entry."""

from __future__ import annotations

import json
import uuid
from importlib.metadata import version
from pathlib import Path

import tornado.web
from jupyter_core.utils import ensure_async
from jupyter_core.paths import jupyter_data_dir
from jupyter_server.auth.decorator import authorized
from jupyter_server.base.handlers import APIHandler
from jupyter_server.extension.application import ExtensionApp
from jupyter_server.extension.handler import ExtensionHandlerMixin
from traitlets import Float, Integer, Unicode

from .documents import Documents
from .executions import Executions
from .ledger import ACTIVE, Ledger

ID = r"[A-Za-z0-9_-]+"


def text(data, name, *, empty=False, limit=262144):
    value = data.get(name)
    if not isinstance(value, str) or (not empty and not value) or len(value.encode("utf-8")) > limit:
        raise tornado.web.HTTPError(400, reason=f"invalid {name}")
    return value


def controller(data):
    if not isinstance(data, dict):
        raise tornado.web.HTTPError(400, reason="controller required")
    text(data, "ownerId", limit=256)
    generation = data.get("generation")
    if type(generation) is not int or generation < 0 or generation > 9007199254740991:
        raise tornado.web.HTTPError(400, reason="invalid controller generation")
    return data


class Handler(ExtensionHandlerMixin, APIHandler):
    def initialize(self, name, **kwargs):
        super().initialize(name)

    @property
    def coordinator(self):
        return self.extensionapp.components()

    @property
    def principal(self):
        return self.current_user.username

    def body(self):
        if len(self.request.body) > 1_000_000:
            raise tornado.web.HTTPError(413, reason="Notebook request limit exceeded")
        data = self.get_json_body()
        if not isinstance(data, dict):
            raise tornado.web.HTTPError(400, reason="JSON object required")
        return data

    def respond(self, data, status=200):
        self.set_status(status)
        self.finish(json.dumps(data, ensure_ascii=False))

    async def allow(self, action, resource):
        if not await ensure_async(self.authorizer.is_authorized(self, self.current_user, action, resource)):
            raise tornado.web.HTTPError(403, reason=f"not authorized to {action} {resource}")


class StatusHandler(Handler):
    @tornado.web.authenticated
    @authorized(action="read", resource="contents")
    def get(self):
        ledger, documents, executions = self.coordinator
        self.respond({"protocolVersion": 1, "serverNamespace": ledger.namespace,
                      "stack": self.extensionapp.stack, "activeRooms": len(documents.leases),
                      "maxRooms": documents.max_rooms, "idleSeconds": documents.idle_seconds,
                      "pendingRooms": len(documents.pending_rooms),
                      "roomFailures": dict(documents.cleanup_errors),
                      "kernels": len(executions.runtimes), "serverSideExecution": True,
                      "outputRecovery": False})


class OpenHandler(Handler):
    @tornado.web.authenticated
    @authorized(action="read", resource="contents")
    async def post(self):
        data = self.body()
        _, documents, _ = self.coordinator
        path = text(data, "contentPath", limit=4096)
        if path.startswith("/") or "\\" in path or any(part in ("", ".", "..") for part in path.split("/")):
            raise tornado.web.HTTPError(400, reason="relative Jupyter Contents path required")
        self.respond(await documents.open(path, text(data, "connectionId", limit=256)))


class NotebookHandler(Handler):
    @tornado.web.authenticated
    async def post(self, document_id, operation):
        data = self.body()
        ledger, documents, executions = self.coordinator
        notebook = data.get("notebook")
        if not isinstance(notebook, dict) or notebook.get("identity", {}).get("documentId") != document_id:
            raise tornado.web.HTTPError(400, reason="Notebook route and identity mismatch")
        locator = documents.locate(notebook)
        read = operation in ("read-cell", "status", "outputs", "describe")
        await self.allow("read" if read else "write", "contents")
        if operation in ("kernel", "submit", "stop", "input"):
            await self.allow("execute", "kernels")
        if operation == "read-cell":
            result = await documents.read(locator, text(data, "cellId", limit=64))
        elif operation == "edit-cell":
            for key in ("cellId", "expectedRevision", "expectedSourceHash"):
                text(data, key, limit=65536)
            text(data, "source", empty=True)
            controller(data.get("controller"))
            result = await documents.edit(data, self.principal)
        elif operation == "control":
            current = ledger.controller(document_id)
            if data.get("action") == "read":
                result = {"ownerId": current["owner_id"], "generation": current["generation"]} if current else None
            else:
                expected = data.get("expectedGeneration")
                if type(expected) is not int or expected < 0:
                    raise tornado.web.HTTPError(400, reason="expectedGeneration required")
                result = executions.claim(document_id, text(data, "ownerId", limit=256), self.principal, expected)
        elif operation == "kernel":
            result = await executions.bind(locator, data.get("kernelName", "python3"))
        elif operation == "submit":
            target = data.get("target")
            if not isinstance(target, dict) or target.get("notebook") != notebook:
                raise tornado.web.HTTPError(400, reason="execution target Notebook mismatch")
            for key in ("cellId", "expectedRevision", "sourceHash", "kernelId", "kernelIncarnation", "runId"):
                text(target, key, limit=65536)
            controller(target.get("controller"))
            text(data, "source", empty=True)
            try:
                uuid.UUID(target["runId"])
            except ValueError:
                raise tornado.web.HTTPError(400, reason="runId must be a UUID") from None
            result = await executions.submit(data, self.principal)
        elif operation == "status":
            result = executions.status(locator, text(data, "runId", limit=64))
        elif operation == "stop":
            handle = data.get("handle")
            if not isinstance(handle, dict) or handle.get("notebook") != notebook:
                raise tornado.web.HTTPError(400, reason="stop handle Notebook mismatch")
            text(handle, "runId", limit=64)
            result = await executions.stop(handle, controller(data.get("controller")), self.principal)
        elif operation == "input":
            run_id = text(data, "runId", limit=64)
            run = ledger.run(run_id)
            if not run or run["document_id"] != document_id:
                raise tornado.web.HTTPError(404, reason="run not found for Notebook")
            executions.input(run_id, text(data, "inputRequestId", limit=256),
                             text(data, "value", empty=True),
                             controller(data.get("controller")), self.principal)
            result = {"state": "sent"}
        elif operation == "outputs":
            run = ledger.run(text(data, "runId", limit=64))
            if not run or run["document_id"] != document_id:
                raise tornado.web.HTTPError(404, reason="run not found for Notebook")
            result = {"runId": run["run_id"], "outputs": run["details"].get("outputs", []),
                      "truncated": run["details"].get("outputTruncated", False)}
        elif operation == "describe":
            async with documents.access(locator) as (entry, current):
                result = {"notebook": current, "cells": [
                    {"cellId": c.get("id"), "cellType": c.get("cell_type"),
                     "sourcePreview": str(c["source"])[:2000],
                     "execution": c.get("metadata", {}).get("disclaude_execution")}
                    for c in entry.document.ycells
                ]}
        else:
            raise tornado.web.HTTPError(404, reason="unknown Notebook operation")
        self.respond(result)


class LabExecuteHandler(Handler):
    @tornado.web.authenticated
    @authorized(action="execute", resource="kernels")
    async def post(self, kernel_id):
        await self.allow("write", "contents")
        data = self.body()
        ledger, documents, executions = self.coordinator
        metadata = data.get("metadata", {})
        path = text(metadata, "document_path", limit=4096)
        notebook = await documents.open(path, "jupyterlab")
        room_id = metadata.get("document_id")
        if room_id and room_id != "json:notebook:" + notebook["identity"]["documentId"]:
            raise tornado.web.HTTPError(409, reason="Lab document identity mismatch")
        kernel = await executions.bind(notebook)
        if kernel["kernelId"] != kernel_id:
            raise tornado.web.HTTPError(409, reason="Lab kernel is not owned by this Notebook")
        snapshot = await documents.read(notebook, text(metadata, "cell_id", limit=64))
        code = text(data, "code", empty=True)
        if code != snapshot["source"]:
            raise tornado.web.HTTPError(409, reason="Lab code differs from the live shared document")
        current = ledger.controller(notebook["identity"]["documentId"])
        lease = executions.claim(notebook["identity"]["documentId"], "human:" + self.principal,
                                 self.principal, current["generation"] if current else 0)
        result = await executions.submit({"target": {
            "notebook": notebook, "cellId": snapshot["cellId"], "expectedRevision": snapshot["revision"],
            "sourceHash": snapshot["sourceHash"], **kernel, "runId": str(uuid.uuid4()), "controller": lease,
        }, "source": code}, self.principal)
        if result["state"] != "accepted":
            raise tornado.web.HTTPError(409, reason=result.get("reason", "execution was not accepted"))
        handle = result["handle"]
        url = f"{self.base_url}api/kernels/{kernel_id}/requests/{handle['requestId']}"
        self.set_header("Location", url)
        self.respond({"request_id": handle["requestId"], "kernel_id": kernel_id,
                      "cell_id": handle["cellId"], "document_path": path, "pending": True,
                      "request_status": "queued", "request_url": url, "outputs": "[]"}, 202)


class LabRunHandler(Handler):
    def run(self, kernel_id, request_id):
        ledger, _, _ = self.coordinator
        run = ledger.request(request_id)
        if not run or run["kernel_id"] != kernel_id:
            raise tornado.web.HTTPError(404, reason="execution request not found")
        return run


class LabRequestHandler(LabRunHandler):
    @tornado.web.authenticated
    @authorized(action="read", resource="kernels")
    def get(self, kernel_id, request_id):
        run = self.run(kernel_id, request_id)
        state = run["state"]
        if state == "unknown":
            self.respond({"error": run["details"].get("reason", "execution outcome unknown"),
                          "request_status": "unknown", "pending": False}, 409)
            return
        details = run["details"]
        reply = details.get("kernelReply", {})
        self.respond({"request_id": request_id, "kernel_id": kernel_id,
                      "cell_id": run["target"]["cellId"], "request_status": state,
                      "pending": state in ACTIVE, "status": reply.get("status"),
                      "execution_count": reply.get("execution_count"),
                      "outputs": json.dumps(details.get("outputs", [])),
                      "input": details.get("input"),
                      "input_request_id": details.get("inputRequestId")},
                     300 if state == "input_required" else 202 if state in ACTIVE else 200)

    @tornado.web.authenticated
    @authorized(action="execute", resource="kernels")
    async def delete(self, kernel_id, request_id):
        run = self.run(kernel_id, request_id)
        if run["target"]["controller"]["ownerId"] != "human:" + self.principal:
            raise tornado.web.HTTPError(409, reason="Lab stop does not own this execution")
        _, _, executions = self.coordinator
        result = await executions.stop(executions.handle(run), run["target"]["controller"], self.principal)
        if result["state"] != "requested":
            raise tornado.web.HTTPError(409, reason=result.get("reason", result["state"]))
        self.set_status(204)
        self.finish()


class LabInputHandler(LabRunHandler):
    @tornado.web.authenticated
    @authorized(action="execute", resource="kernels")
    def post(self, kernel_id, request_id):
        run = self.run(kernel_id, request_id)
        if run["target"]["controller"]["ownerId"] != "human:" + self.principal:
            raise tornado.web.HTTPError(409, reason="Lab input does not own this execution")
        data = self.body()
        _, _, executions = self.coordinator
        executions.input(run["run_id"], text(data, "input_request_id", limit=256),
                         text(data, "input", empty=True), run["target"]["controller"], self.principal)
        self.respond({"state": "sent"}, 201)


class RecoveryHandler(Handler):
    @tornado.web.authenticated
    @authorized(action="read", resource="contents")
    def get(self):
        self.respond({"outputRecovery": False})

    @tornado.web.authenticated
    @authorized(action="write", resource="contents")
    def post(self):
        raise tornado.web.HTTPError(409, reason="unfenced frontend output recovery is unsupported")


class NotebookExtension(ExtensionApp):
    name = "disclaude_jupyter"
    ledger_path = Unicode("", config=True)
    idle_seconds = Float(60, min=1, config=True)
    max_rooms = Integer(16, min=1, config=True)

    def initialize_handlers(self):
        self.stack = {name: version(name) for name in (
            "jupyter-server", "jupyter-server-ydoc", "jupyter-server-nbmodel", "jupyter-ydoc", "pycrdt"
        )}
        expected = {"jupyter-server": "2.21.1", "jupyter-server-ydoc": "3.0.4",
                    "jupyter-server-nbmodel": "0.2.9", "jupyter-ydoc": "4.1.1", "pycrdt": "0.14.8"}
        if self.stack != expected:
            raise RuntimeError("Notebook coordinator requires its verified managed stack")
        original = self.serverapp.extension_manager.extensions.get("jupyter_server_nbmodel")
        if original and original.enabled:
            raise RuntimeError("disable the original nbmodel server routes before enabling the coordinator")
        self._components = None
        self.handlers.extend([
            (r"/api/disclaude", StatusHandler, {}),
            (r"/api/disclaude/notebooks", OpenHandler, {}),
            (rf"/api/disclaude/notebooks/({ID})/({ID})", NotebookHandler, {}),
            (rf"/api/kernels/({ID})/execute", LabExecuteHandler, {}),
            (rf"/api/kernels/({ID})/requests/({ID})", LabRequestHandler, {}),
            (rf"/api/kernels/({ID})/requests/({ID})/input", LabInputHandler, {}),
            (r"/api/nbmodel/settings/output-recovery", RecoveryHandler, {}),
        ])

    def components(self):
        if self._components is None:
            apps = self.serverapp.extension_manager.extension_apps.get("jupyter_server_ydoc", set())
            if len(apps) != 1:
                raise tornado.web.HTTPError(503, reason="one RTC extension is required")
            rtc = next(iter(apps))
            if not rtc.server_side_execution:
                raise tornado.web.HTTPError(503, reason="enable RTC server_side_execution for shared Lab Run")
            settings = self.serverapp.web_app.settings
            path = self.ledger_path or str(Path(jupyter_data_dir()) / "disclaude" / "notebooks.sqlite3")
            ledger = Ledger(path)
            documents = Documents(rtc, settings["file_id_manager"], settings["contents_manager"], ledger,
                                  idle_seconds=self.idle_seconds, max_rooms=self.max_rooms)
            executions = Executions(settings["kernel_manager"], settings["session_manager"], documents, ledger)
            self._components = ledger, documents, executions
        return self._components

    async def stop_extension(self):
        if self._components is not None:
            ledger, documents, executions = self._components
            errors = []
            try:
                for component in (executions, documents):
                    try:
                        await component.close()
                    except Exception as error:
                        errors.append(error)
            finally:
                ledger.close()
            if errors:
                raise ExceptionGroup("Notebook coordinator shutdown is incomplete", errors)

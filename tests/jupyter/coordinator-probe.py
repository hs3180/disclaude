"""Opt-in real Jupyter coordinator test, with only owned local resources.

Run with the pinned managed-stack Python and --output <new-report.json>.
This tests the backend. It does not claim model, Feishu or human UI acceptance.
"""

import argparse
import asyncio
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

import httpx
import nbformat
from httpx_ws import aconnect_ws
from jupyter_ydoc import YNotebook
from pycrdt import Provider
from pycrdt.websocket.websocket import HttpxWebsocket


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


async def eventually(check, *, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = await check()
        if result:
            return result
        await asyncio.sleep(0.1)
    raise TimeoutError("coordinator condition did not become true")


async def probe(args, report):
    root = Path(tempfile.mkdtemp(prefix="disclaude-jupyter-coordinator-"))
    root.chmod(0o700)
    report["ownedRoot"] = str(root)
    token = secrets.token_urlsafe(32)
    for directory in ("workspace", "config", "data", "runtime", "settings", "workspaces", "ipython"):
        (root / directory).mkdir(mode=0o700)
    config = root / "config/jupyter_server_config.py"
    config.write_text(
        "c.IdentityProvider.token = " + repr(token) + "\n"
        "c.ServerApp.jpserver_extensions = {'jupyterlab': True, 'jupyter_server_fileid': True, "
        "'jupyter_server_ydoc': True, 'jupyter_server_nbmodel': False, 'disclaude_jupyter': True}\n"
        "c.ServerApp.root_dir = " + repr(str(root / "workspace")) + "\n"
        "c.ServerApp.open_browser = False\n"
        "c.ServerApp.allow_remote_access = False\n"
        "c.YDocExtension.server_side_execution = True\n"
        "c.YDocExtension.document_cleanup_delay = 1\n"
        "c.YDocExtension.document_save_delay = 30\n"
        "c.NotebookExtension.idle_seconds = 2\n"
        "c.NotebookExtension.ledger_path = " + repr(str(root / "data/ledger.sqlite3")) + "\n",
        encoding="utf-8",
    )
    config.chmod(0o600)
    env = dict(os.environ)
    for variable, directory in {
        "JUPYTER_CONFIG_DIR": "config", "JUPYTER_DATA_DIR": "data", "JUPYTER_RUNTIME_DIR": "runtime",
        "JUPYTERLAB_SETTINGS_DIR": "settings", "JUPYTERLAB_WORKSPACES_DIR": "workspaces", "IPYTHONDIR": "ipython",
    }.items():
        env[variable] = str(root / directory)
    env["JUPYTER_CONFIG_PATH"] = ""
    env["JUPYTER_PATH"] = ""
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2] / "jupyter")
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    log_path = root / "server.log"
    log_path.touch(mode=0o600)
    log = log_path.open("w")
    process = subprocess.Popen([
        sys.executable, "-m", "jupyterlab", "--no-browser", "--ip=127.0.0.1", f"--port={port}",
        "--ServerApp.port_retries=0",
    ], cwd=root / "workspace", env=env, stdout=log, stderr=subprocess.STDOUT)
    report["ownedServerPid"] = process.pid
    report["scope"] = ("real managed backend and native DSH model; no Feishu/user server or native UI"
                       if args.dsh_checkout else "real managed backend; no model/Feishu/user server or native UI")
    client = httpx.AsyncClient(headers={"Authorization": "token " + token}, timeout=30, follow_redirects=False)

    def stage(name):
        report["stages"].append(name)
        print(json.dumps({"stage": name}), flush=True)

    async def post(path, data):
        response = await client.post(base + path, json=data)
        require(response.status_code in (200, 201, 202), f"{path}: HTTP {response.status_code}: {response.text[:500]}")
        return response.json()

    try:
        async def ready():
            require(process.poll() is None, "owned Jupyter server exited during startup")
            try:
                response = await client.get(base + "/api/disclaude")
                if response.status_code == 500:
                    raise RuntimeError("coordinator startup returned HTTP 500; inspect sanitized report log")
                return response.json() if response.status_code == 200 else None
            except httpx.TransportError:
                return None
        status = await eventually(ready, timeout=60)
        report["stack"] = status["stack"]
        stage("server_ready")
        path = "coordinator-" + str(uuid.uuid4()) + ".ipynb"
        notebook = nbformat.v4.new_notebook(cells=[
            nbformat.v4.new_markdown_cell("Human wording must survive", id="human-note"),
            nbformat.v4.new_code_cell("value = 41\nprint(value + 1)", id="short-cell"),
            nbformat.v4.new_code_cell("import time\nprint('RUNNING', flush=True)\ntime.sleep(30)\nprint('LATE')", id="long-cell"),
        ])
        response = await client.put(base + "/api/contents/" + path,
                                    json={"type": "notebook", "format": "json", "content": notebook})
        require(response.status_code == 201, "owned Notebook creation failed")
        locator = await post("/api/disclaude/notebooks", {"contentPath": path, "connectionId": "owned-probe"})
        document_id = locator["identity"]["documentId"]
        prefix = "/api/disclaude/notebooks/" + document_id + "/"

        async def operation(name, **values):
            return await post(prefix + name, {"notebook": locator, **values})

        lease = await operation("control", ownerId="probe-agent", expectedGeneration=0)
        first = await operation("read-cell", cellId="short-cell")
        collaboration = await client.put(base + "/api/collaboration/session/" + path,
                                         json={"format": "json", "type": "notebook"})
        require(collaboration.status_code in (200, 201), "RTC session creation failed")
        rtc = collaboration.json()
        room_id = "json:notebook:" + rtc["fileId"]
        peer = YNotebook()
        ws_url = base.replace("http://", "ws://") + "/api/collaboration/room/" + room_id + "?sessionId=" + rtc["sessionId"]
        async with (aconnect_ws(ws_url, client=client) as websocket,
                    Provider(peer.ydoc, HttpxWebsocket(websocket, room_id))):
            async def synced():
                return len(peer.ycells) == 3
            await eventually(synced)
            with peer.ydoc.transaction():
                peer_source = peer.ycells[0]["source"]
                peer_source += "\nUnsaved human revision"
            async def observed_unsaved():
                value = await operation("read-cell", cellId="human-note")
                return value if "Unsaved human revision" in value["source"] else None
            await eventually(observed_unsaved)
            disk = (await client.get(base + "/api/contents/" + path)).json()["content"]
            require("Unsaved human revision" not in disk["cells"][0]["source"], "RTC test edit was already saved")
        human_source = "Human wording must survive\nUnsaved human revision"
        first = await operation("read-cell", cellId="short-cell")
        stage("unsaved_rtc_peer_edit_is_visible")
        edited = await operation("edit-cell", cellId="short-cell", expectedRevision=first["revision"],
                                 expectedSourceHash=first["sourceHash"], source=first["source"] + "\n# UTF-8: 中文 🧪", controller=lease)
        require(edited["state"] == "applied", "versioned edit failed")
        stale = await operation("edit-cell", cellId="short-cell", expectedRevision=first["revision"],
                                expectedSourceHash=first["sourceHash"], source="must not overwrite", controller=lease)
        require(stale["state"] == "conflict", "stale edit was not rejected")
        require((await operation("read-cell", cellId="human-note"))["source"] == human_source, "other cell changed")
        stage("atomic_cell_edit_and_conflict")
        kernel = await operation("kernel")

        async def submit(cell_id):
            snapshot = await operation("read-cell", cellId=cell_id)
            target = {"notebook": locator, "cellId": cell_id, "expectedRevision": snapshot["revision"],
                      "sourceHash": snapshot["sourceHash"], **kernel, "controller": lease, "runId": str(uuid.uuid4())}
            result = await operation("submit", target=target, source=snapshot["source"])
            require(result["state"] == "accepted", "execution submission failed: " + str(result))
            return result["handle"]

        async def terminal(handle):
            async def check():
                observation = await operation("status", runId=handle["runId"])
                return observation if observation["state"] not in ("queued", "running", "input_required", "stopping") else None
            return await eventually(check)

        short = await submit("short-cell")
        finished = await terminal(short)
        require(finished["state"] == "completed", "short execution failed: " + str(finished))
        async def persisted():
            state = await operation("status", runId=short["runId"])
            return state if state.get("details", {}).get("persisted") is True else None
        await eventually(persisted)
        saved = (await client.get(base + "/api/contents/" + path)).json()["content"]
        require("42" in json.dumps(saved["cells"][1]["outputs"]), "saved output missing")
        require(saved["cells"][0]["source"] == human_source, "human text lost on execution")
        report["shortRun"] = short
        stage("native_execution_and_saved_output")

        long = await submit("long-cell")
        async def running():
            values = await operation("outputs", runId=long["runId"])
            return values if "RUNNING" in json.dumps(values["outputs"]) else None
        await eventually(running)
        stop = await operation("stop", handle=long, controller=lease)
        require(stop["state"] == "requested", "stop not accepted")
        cancelled = await terminal(long)
        report["stopAcknowledgment"] = stop
        report["cancelledObservation"] = cancelled
        require(cancelled["state"] == "cancelled" and cancelled["details"].get("kernelIdleConfirmed"), "kernel stop not confirmed: " + str(cancelled))
        output = await operation("outputs", runId=long["runId"])
        report["cancelledOutputs"] = output
        require(not any(o.get("output_type") == "stream" and "LATE" in o.get("text", "") for o in output["outputs"]), "cancelled code emitted the late stream marker")
        stage("exact_run_stop_with_kernel_confirmation")

        recovery = await submit("short-cell")
        require((await terminal(recovery))["state"] == "completed", "same kernel failed after interrupt")
        stage("same_kernel_recovery")
        if args.dsh_checkout:
            native_report = Path(args.output).resolve().with_name(Path(args.output).stem + "-native-dsh.json")
            native_environment = dict(os.environ)
            native_environment["DISCLAUDE_JUPYTER_PROBE_TOKEN"] = token
            native = await asyncio.create_subprocess_exec(
                "node", str(Path(__file__).with_name("dsh-notebook-probe.mjs")),
                "--dsh-checkout", args.dsh_checkout, "--oauth-auth-file", args.oauth_auth_file,
                "--model", args.model, "--binary", args.dsh_binary,
                "--server-url", base, "--notebook", path, "--output", str(native_report),
                cwd=Path(__file__).resolve().parents[2], env=native_environment,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
            stdout, _ = await native.communicate()
            report["nativeProbeReport"] = str(native_report)
            report["nativeProbeExitCode"] = native.returncode
            report["nativeProbeSummary"] = stdout.decode(errors="replace").replace(token, "<redacted>")[-4000:]
            require(native.returncode == 0, "DSH Notebook probe failed; inspect its owned report")
            current_lease = await operation("control", action="read")
            lease = await operation("control", ownerId="probe-agent", expectedGeneration=current_lease["generation"])
            require((await operation("read-cell", cellId="human-note"))["source"] == human_source,
                    "DSH Notebook operations lost human text")
            stage("real_dsh_notebook_read_edit_run_resume_stop")
        replacement = await operation("control", ownerId="next-agent", expectedGeneration=lease["generation"])
        current = await operation("read-cell", cellId="short-cell")
        old_edit = await operation("edit-cell", cellId="short-cell", expectedRevision=current["revision"],
                                  expectedSourceHash=current["sourceHash"], source="old owner", controller=lease)
        require(old_edit["state"] == "ownership_lost", "old edit authority survived handoff")
        require((await operation("stop", handle=long, controller=lease))["state"] == "ownership_lost", "old stop authority survived handoff")
        stage("controller_generation_fences")

        lab = await post(f"/api/kernels/{kernel['kernelId']}/execute", {
            "code": current["source"], "metadata": {"document_path": path,
                "document_id": "json:notebook:" + document_id, "cell_id": "short-cell"},
        })
        async def lab_done():
            response = await client.get(base + f"/api/kernels/{kernel['kernelId']}/requests/{lab['request_id']}")
            require(response.status_code in (200, 202), "Lab execution query failed")
            return response.json() if response.status_code == 200 else None
        require((await eventually(lab_done))["status"] == "ok", "Lab shared entry did not execute")
        stage("lab_run_uses_shared_coordinator")
        human_controller = await operation("control", action="read")
        current = await operation("read-cell", cellId="short-cell")
        interactive_source = "first = input('First: ')\nsecond = input('Second: ')\nprint('LAB_INPUT', first, second)"
        edited = await operation("edit-cell", cellId="short-cell", expectedRevision=current["revision"],
                                 expectedSourceHash=current["sourceHash"], source=interactive_source,
                                 controller=human_controller)
        require(edited["state"] == "applied", "interactive source edit failed")
        current = edited["snapshot"]
        interactive = await post(f"/api/kernels/{kernel['kernelId']}/execute", {
            "code": interactive_source, "metadata": {"document_path": path,
                "document_id": "json:notebook:" + document_id, "cell_id": "short-cell"},
        })
        request_path = f"/api/kernels/{kernel['kernelId']}/requests/{interactive['request_id']}"
        async def waiting_input(previous=None):
            response = await client.get(base + request_path)
            require(response.status_code in (202, 300), "interactive execution failed before input")
            value = response.json()
            return value if response.status_code == 300 and value["input_request_id"] != previous else None
        first_prompt = (await eventually(waiting_input))["input_request_id"]
        require((await client.post(base + request_path + "/input", json={"input": "missing identity"})).status_code == 400,
                "Lab accepted an input without prompt identity")
        require((await client.post(base + f"/api/kernels/{kernel['kernelId']}/requests/missing/input", json={
            "input_request_id": first_prompt, "input": "wrong execution",
        })).status_code == 404, "Lab input adopted an unknown native execution")
        async with httpx.AsyncClient(headers={"Authorization": "token " + token}, timeout=30) as other_client:
            await other_client.get(base + "/api/disclaude")
            require((await other_client.post(base + request_path + "/input", json={
                "input_request_id": first_prompt, "input": "another principal",
            })).status_code == 409, "Lab input adopted another authenticated principal")
        require((await client.post(base + f"/api/disclaude/notebooks/{document_id}/input", json={
            "notebook": locator, "runId": str(uuid.uuid4()), "inputRequestId": first_prompt,
            "controller": human_controller, "value": "unknown run",
        })).status_code == 404, "Notebook input adopted an unknown run")
        await post(request_path + "/input", {"input_request_id": first_prompt, "input": "answer-1"})
        second_prompt = (await eventually(lambda: waiting_input(first_prompt)))["input_request_id"]
        require((await client.post(base + request_path + "/input", json={
            "input_request_id": first_prompt, "input": "stale reply",
        })).status_code == 409, "late input reply reached the next prompt")
        await post(request_path + "/input", {"input_request_id": second_prompt, "input": "answer-2"})
        async def interactive_done():
            response = await client.get(base + request_path)
            require(response.status_code in (200, 202), "interactive execution did not complete")
            return response.json() if response.status_code == 200 else None
        interactive_result = await eventually(interactive_done)
        require(interactive_result["status"] == "ok" and
                "LAB_INPUT answer-1 answer-2" in interactive_result["outputs"], "interactive result differs")
        require((await client.post(base + request_path + "/input", json={
            "input_request_id": second_prompt, "input": "late terminal reply",
        })).status_code == 409, "terminal run accepted input")
        stage("lab_input_binds_run_and_each_native_prompt")
        async def idle_rooms():
            response = await client.get(base + "/api/disclaude")
            return response.json() if response.json()["activeRooms"] == 0 else None
        await eventually(idle_rooms)
        reopened = await operation("read-cell", cellId="short-cell")
        require(reopened["source"] == current["source"], "cold-loaded source differs")
        stage("bounded_room_cleanup_and_cold_load")
        response = await client.post(base + f"/api/kernels/{kernel['kernelId']}/restart", json={})
        require(response.status_code == 200, "explicit kernel restart failed")
        renewed = await operation("kernel")
        require(renewed["kernelId"] == kernel["kernelId"] and renewed["kernelIncarnation"] != kernel["kernelIncarnation"], "kernel restart reused the old incarnation")
        stage("kernel_restart_has_new_incarnation")
        report["result"] = "passed"
        report["notebookProduct"] = "not_executed"
    finally:
        if process.poll() is None:
            try:
                await client.post(base + "/api/shutdown")
            except httpx.HTTPError:
                pass
            try:
                await asyncio.to_thread(process.wait, 15)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    await asyncio.to_thread(process.wait, 5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    await asyncio.to_thread(process.wait, 5)
        await client.aclose()
        log.close()
        report["serverExitCode"] = process.returncode
        report["serverLogTail"] = log_path.read_text(errors="replace")[-12000:].replace(token, "<redacted>")
        shutil.rmtree(root)
        report["ownedRootRemoved"] = not root.exists()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--dsh-checkout")
    parser.add_argument("--oauth-auth-file")
    parser.add_argument("--model")
    parser.add_argument("--dsh-binary", default="dsh")
    args = parser.parse_args()
    if args.dsh_checkout and not (args.oauth_auth_file and args.model):
        parser.error("DSH probe requires explicit --oauth-auth-file and --model")
    output = Path(args.output).resolve()
    if output.exists():
        parser.error("output must be a new report path")
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {"stages": [], "result": "failed", "startedAt": time.time()}
    try:
        asyncio.run(probe(args, report))
    except BaseException as error:
        report["error"] = type(error).__name__ + ": " + str(error)
        def details(value):
            children = getattr(value, "exceptions", ())
            return [part for child in children for part in details(child)] if children else [type(value).__name__ + ": " + str(value)]
        report["errorDetails"] = details(error)
    finally:
        report["endedAt"] = time.time()
        fd = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    print(json.dumps({"result": report["result"], "stages": report["stages"], "error": report.get("error"), "report": str(output)}), flush=True)
    return 0 if report["result"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

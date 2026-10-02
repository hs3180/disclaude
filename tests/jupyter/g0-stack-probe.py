"""Opt-in #5216 experiment against an owned, isolated Jupyter stack.

This uses real JupyterLab, RTC, nbmodel, and ipykernel. It does not connect
Disclaude, a model, Feishu, a user's server, or an existing Notebook.
"""

import argparse
import asyncio
import hashlib
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from importlib.metadata import version
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

import httpx
import nbformat
from httpx_ws import aconnect_ws
from jupyter_ydoc import YNotebook
from playwright.async_api import async_playwright
from pycrdt import Provider
from pycrdt.websocket.websocket import HttpxWebsocket


VERSIONS = {
    "jupyterlab": "4.6.3",
    "jupyter-server": "2.21.1",
    "jupyter-collaboration": "5.0.4",
    "jupyter-server-ydoc": "3.0.4",
    "jupyter-docprovider": "3.0.4",
    "jupyter-server-nbmodel": "0.2.9",
    "jupyter-ydoc": "4.1.1",
    "pycrdt": "0.14.8",
    "ipykernel": "7.4.0",
    "nbformat": "5.11.1",
    "nbconvert": "7.17.1",
    "httpx": "0.28.1",
    "httpx-ws": "0.9.0",
    "playwright": "1.63.0",
}
SETTING_ID = "@datalayer/jupyter-server-nbmodel:notebook-cell-executor"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(notebook):
    canonical = json.dumps(
        notebook, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def outputs(cell):
    return json.dumps(cell.get("outputs", []), ensure_ascii=False)


def error_details(error):
    children = getattr(error, "exceptions", ())
    if children:
        return [detail for child in children for detail in error_details(child)]
    return [type(error).__name__ + ": " + str(error)]


def stage(report, value):
    report["stage"] = value
    print(json.dumps({"stage": value, "scope": report["scope"]}), flush=True)


async def eventually(check, label, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = await check()
        if result:
            return result
        await asyncio.sleep(0.2)
    raise RuntimeError("Timed out: " + label)


async def request_result(client, url):
    async def done():
        response = await client.get(url)
        if response.status_code == 202:
            return None
        require(
            response.status_code == 200,
            "Execution query returned HTTP " + str(response.status_code),
        )
        value = response.json()
        if value.get("request_status") in ("pending", "running"):
            return None
        return value

    result = await eventually(done, "execution completion")
    require(result.get("status") == "ok", "Execution did not report success")
    return result


async def notebook(client, base, path):
    response = await client.get(base + "/api/contents/" + quote(path))
    require(
        response.status_code == 200,
        "Notebook read returned HTTP " + str(response.status_code),
    )
    value = response.json()["content"]
    nbformat.validate(value)
    return value


async def unattended_bootstrap(args, client, base, root, path, content, marker, report):
    report["ui_operations_budget"] = 0
    report["ui_operations_performed"] = []
    report["browser_pages_ever_opened"] = 0
    session = await client.post(
        base + "/api/sessions",
        json={
            "path": path,
            "name": path,
            "type": "notebook",
            "kernel": {"name": "python3"},
        },
    )
    require(session.status_code == 201, "Unattended kernel session creation failed")
    kernel_id = session.json()["kernel"]["id"]
    report["kernel_id"] = kernel_id
    collab = await client.put(
        base + "/api/collaboration/session/" + path,
        json={"format": "json", "type": "notebook"},
    )
    require(collab.status_code in (200, 201), "Unattended RTC session creation failed")
    identity = collab.json()
    room = identity["format"] + ":" + identity["type"] + ":" + identity["fileId"]
    report["notebook_identity"] = {
        "document_id": identity["fileId"],
        "room": room,
        "path": path,
        "cell_ids": [cell["id"] for cell in content["cells"]],
    }
    ws_url = (
        base.replace("http://", "ws://")
        + "/api/collaboration/room/"
        + room
        + "?sessionId="
        + identity["sessionId"]
    )
    peer = YNotebook()
    async with (
        aconnect_ws(ws_url, client=client) as websocket,
        Provider(peer.ydoc, HttpxWebsocket(websocket, room)),
    ):

        async def initial_sync():
            cells = peer.get().get("cells", [])
            return len(cells) == len(content["cells"]) and all(
                actual["id"] == expected["id"]
                and actual["source"] == expected["source"]
                for actual, expected in zip(cells, content["cells"])
            )

        await eventually(initial_sync, "unattended RTC document initialization")
    report["document_bootstrap"] = "transient RTC peer"
    report["browser_pages_during_background_execution"] = 0
    report["rtc_probe_peer_during_background_execution"] = False
    stage(report, "unattended_document_initialized_peer_disconnected")
    disconnected_at = time.monotonic()

    async def room_lifetime_observed():
        deleted = "Room " + room + " deleted" in (root / "server.log").read_text()
        if args.room_retention == "server":
            require(not deleted, "Server-retained unattended room was deleted")
        return time.monotonic() - disconnected_at >= 61 and (
            deleted if args.room_retention == "cleanup" else not deleted
        )

    await eventually(room_lifetime_observed, "unattended room lifetime", timeout=90)
    report["seconds_after_last_peer_disconnect"] = round(
        time.monotonic() - disconnected_at, 3
    )
    report["rtc_room_deleted_before_background_execution"] = (
        args.room_retention == "cleanup"
    )
    cell = content["cells"][2]
    report["source_sha256"] = {
        "background": hashlib.sha256(cell["source"].encode()).hexdigest()
    }
    submit = await client.post(
        base + "/api/kernels/" + kernel_id + "/execute",
        json={
            "code": cell["source"],
            "metadata": {
                "document_id": room,
                "document_path": path,
                "cell_id": cell["id"],
            },
        },
    )
    require(submit.status_code == 202, "First unattended execution was not accepted")
    request_id = submit.json()["request_id"]
    report["background_request_id"] = request_id
    result = await request_result(
        client, base + "/api/kernels/" + kernel_id + "/requests/" + request_id
    )
    report["background_execution"] = {
        "request_status": result.get("request_status"),
        "status": result.get("status"),
        "execution_count": result.get("execution_count"),
    }
    require(
        "BACKGROUND_" + marker in json.dumps(result)
        and "image/svg+xml" in json.dumps(result),
        "Unattended request result lacked its stdout or SVG",
    )
    stage(report, "first_unattended_request_completed")

    async def saved_output():
        value = await notebook(client, base, path)
        saved_cell = value["cells"][2]
        report["last_background_cell_output_count"] = len(saved_cell.get("outputs", []))
        return (
            value
            if "BACKGROUND_" + marker in outputs(saved_cell)
            and "image/svg+xml" in outputs(saved_cell)
            else None
        )

    saved = await eventually(saved_output, "first unattended output saved by server")
    require(
        all(
            actual["id"] == expected["id"] and actual["source"] == expected["source"]
            for actual, expected in zip(saved["cells"], content["cells"])
        )
        and len(saved["cells"]) == len(content["cells"]),
        "Unattended execution changed initial cell identity or source",
    )
    report["server_saved_background_outputs"] = True
    report["initial_cell_ids_and_sources_preserved"] = True
    report["saved_notebook_sha256"] = digest(saved)
    if args.report:
        args.report.with_suffix(".ipynb").write_text(
            json.dumps(saved, ensure_ascii=False, indent=2) + "\n"
        )
    stage(report, "first_unattended_output_saved")


async def run_probe(args, root, token, report):
    workspace = root / "workspace"
    for name in ("workspace", "config", "data", "runtime", "settings", "workspaces"):
        (root / name).mkdir()
    config = root / "config/jupyter_server_config.py"
    cleanup_delay = 60 if args.room_retention == "cleanup" else None
    config.write_text(
        "c.IdentityProvider.token = " + repr(token) + "\n"
        "c.ServerApp.open_browser = False\n"
        "c.ServerApp.allow_remote_access = False\n"
        "c.ServerApp.root_dir = " + repr(str(workspace)) + "\n"
        "c.YDocExtension.server_side_execution = True\n"
        "c.YDocExtension.document_save_delay = 30\n"
        "c.YDocExtension.document_cleanup_delay = " + repr(cleanup_delay) + "\n",
        encoding="utf-8",
    )
    config.chmod(0o600)
    setting = (
        root
        / "settings/@datalayer/jupyter-server-nbmodel/notebook-cell-executor.jupyterlab-settings"
    )
    setting.parent.mkdir(parents=True)
    setting.write_text(json.dumps({"outputRecovery": args.output_recovery}))
    environment = dict(os.environ)
    for variable, directory in {
        "JUPYTER_CONFIG_DIR": "config",
        "JUPYTER_DATA_DIR": "data",
        "JUPYTER_RUNTIME_DIR": "runtime",
        "JUPYTERLAB_SETTINGS_DIR": "settings",
        "JUPYTERLAB_WORKSPACES_DIR": "workspaces",
    }.items():
        environment[variable] = str(root / directory)
    environment["JUPYTER_CONFIG_PATH"] = ""
    environment["JUPYTER_PATH"] = ""
    environment["IPYTHONDIR"] = str(root / "ipython")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = "http://127.0.0.1:" + str(port)
    log = (root / "server.log").open("w")
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "jupyterlab",
            "--collaborative",
            "--no-browser",
            "--ip=127.0.0.1",
            "--port=" + str(port),
            "--ServerApp.port_retries=0",
        ],
        cwd=workspace,
        env=environment,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    report["server_owned_pid"] = process.pid
    report["server_bound"] = "127.0.0.1"
    report["document_save_delay_seconds"] = 30
    report["document_cleanup_delay_seconds"] = cleanup_delay
    report["room_retention"] = args.room_retention
    report["contents_put_count"] = 0
    browser = None

    async def count_contents_put(request):
        if request.method == "PUT" and request.url.path.startswith("/api/contents/"):
            report["contents_put_count"] += 1

    client = httpx.AsyncClient(
        headers={"Authorization": "token " + token},
        timeout=15,
        event_hooks={"request": [count_contents_put]},
    )
    try:

        async def ready():
            require(
                process.poll() is None, "Owned Jupyter process exited during startup"
            )
            try:
                response = await client.get(base + "/api/status", timeout=1)
                return response.status_code == 200
            except httpx.HTTPError:
                return False

        await eventually(ready, "Jupyter startup", timeout=60)
        stage(report, "authenticated_server")
        async with httpx.AsyncClient(timeout=5) as anonymous:
            response = await anonymous.get(base + "/api/contents")
            require(
                response.status_code in (302, 403),
                "Anonymous Contents access was not rejected",
            )
        schema = await client.get(base + "/lab/api/settings/" + SETTING_ID)
        require(schema.status_code == 200, "nbmodel settings schema is unavailable")
        actual_setting = json.loads(schema.json().get("raw", "{}"))
        require(
            actual_setting.get("outputRecovery") == args.output_recovery,
            "Lab did not load this probe's recovery setting",
        )
        report["output_recovery"] = args.output_recovery

        marker = "G0_" + secrets.token_hex(8)
        path = "research.ipynb"
        note_id, human_id, background_id = (
            "note-" + marker,
            "human-" + marker,
            "background-" + marker,
        )
        original_note = "# Research question\n\nOriginal explanation " + marker
        edited_note = "# Research question\n\nHuman explanation preserved " + marker
        original_code = "parameter = 1\nprint('ORIGINAL_" + marker + "', parameter)"
        edited_code = "parameter = 2\nprint('HUMAN_" + marker + "', parameter)"
        background_code = (
            "from IPython.display import display, SVG\nimport time\n"
            "print('BACKGROUND_" + marker + "')\n"
            "time.sleep(3)\n"
            'display(SVG(\'<svg xmlns="http://www.w3.org/2000/svg" width="360" height="90">'
            '<rect width="360" height="90" fill="#eef4ff"/>'
            '<text x="12" y="50" font-size="16">Chart ' + marker + "</text></svg>'))"
        )
        content = nbformat.v4.new_notebook(
            cells=[
                nbformat.v4.new_markdown_cell(original_note, id=note_id),
                nbformat.v4.new_code_cell(original_code, id=human_id),
                nbformat.v4.new_code_cell(background_code, id=background_id),
            ],
            metadata={
                "kernelspec": {
                    "display_name": "Python 3",
                    "language": "python",
                    "name": "python3",
                }
            },
        )
        created = await client.put(
            base + "/api/contents/" + path,
            json={"type": "notebook", "format": "json", "content": content},
        )
        require(created.status_code == 201, "Scratch notebook was not created")

        if args.unattended_bootstrap:
            await unattended_bootstrap(
                args, client, base, root, path, content, marker, report
            )
            return

        async with async_playwright() as playwright:
            options = {"headless": True}
            if args.chromium_executable:
                options["executable_path"] = args.chromium_executable
            browser = await playwright.chromium.launch(**options)
            report["browser_version"] = browser.version
            context = await browser.new_context(viewport={"width": 1280, "height": 900})
            # APIRequestContext shares the browser context's cookie jar; the
            # ephemeral test token never appears in a Notebook entrance URL.
            login = await context.request.get(
                base + "/api/contents", headers={"Authorization": "token " + token}
            )
            require(login.status == 200, "Browser session authentication failed")
            origin = urlparse(base).netloc

            async def restrict_origin(route):
                target = urlparse(route.request.url)
                if target.scheme in ("http", "https") and target.netloc != origin:
                    await route.abort()
                else:
                    await route.continue_()

            await context.route("**/*", restrict_origin)
            page = await context.new_page()
            execute_requests = []

            def observe_request(request):
                request_path = urlparse(request.url).path
                if request.method == "PUT" and request_path.startswith(
                    "/api/contents/"
                ):
                    report["contents_put_count"] += 1
                if request.method == "POST" and "/api/kernels/" in request_path:
                    report.setdefault("kernel_post_paths", []).append(request_path)
                    if request_path.endswith("/execute"):
                        execute_requests.append(
                            {"url": request.url, "body": request.post_data_json}
                        )

            context.on("request", observe_request)
            entrance = base + "/lab/workspaces/g0-" + marker.lower() + "/tree/" + path
            report["ui_operation_budget"] = 6
            report["ui_operations_planned"] = [
                "open",
                "edit Markdown",
                "edit parameter",
                "Run",
                "close",
                "reopen",
            ]
            report["ui_operations_performed"] = ["open"]
            await page.goto(entrance)
            panel = page.locator(".jp-NotebookPanel").first
            await panel.wait_for(state="visible", timeout=60000)
            await panel.locator(".jp-CodeCell .cm-content").first.wait_for(
                state="visible"
            )
            page_config = await page.locator("#jupyter-config-data").text_content()
            require(
                json.loads(page_config).get("serverSideExecution") in (True, "true"),
                "Lab did not load server-side execution config",
            )

            collab = await client.put(
                base + "/api/collaboration/session/" + path,
                json={"format": "json", "type": "notebook"},
            )
            require(collab.status_code in (200, 201), "RTC session creation failed")
            identity = collab.json()
            room = (
                identity["format"] + ":" + identity["type"] + ":" + identity["fileId"]
            )
            report["notebook_identity"] = {
                "document_id": identity["fileId"],
                "room": room,
                "path": path,
                "cell_ids": [note_id, human_id, background_id],
            }
            report["source_sha256"] = {
                "human": hashlib.sha256(edited_code.encode()).hexdigest(),
                "background": hashlib.sha256(background_code.encode()).hexdigest(),
            }
            ws_url = (
                base.replace("http://", "ws://")
                + "/api/collaboration/room/"
                + room
                + "?sessionId="
                + identity["sessionId"]
            )
            peer = YNotebook()
            async with (
                aconnect_ws(ws_url, client=client) as websocket,
                Provider(peer.ydoc, HttpxWebsocket(websocket, room)),
            ):

                async def synced():
                    cells = peer.get().get("cells", [])
                    return len(cells) == 3 and cells[0]["id"] == note_id

                await eventually(synced, "initial RTC sync")
                markdown = panel.locator(".jp-MarkdownCell").first
                report["ui_operations_performed"].append("edit Markdown")
                await markdown.locator(".jp-RenderedMarkdown").dblclick()
                await markdown.locator(".cm-content").fill(edited_note)
                code_editor = panel.locator(".jp-CodeCell .cm-content").first
                report["ui_operations_performed"].append("edit parameter")
                await code_editor.click()
                await code_editor.fill(edited_code)

                async def shared_edit():
                    cells = peer.get().get("cells", [])
                    return (
                        len(cells) == 3
                        and cells[0]["source"] == edited_note
                        and cells[1]["source"] == edited_code
                    )

                await eventually(
                    shared_edit, "human edits reaching independent RTC peer"
                )
                disk = await notebook(client, base, path)
                require(
                    disk["cells"][0]["source"] == original_note
                    and disk["cells"][1]["source"] == original_code,
                    "Human edits were already saved; unsaved-read evidence is missing",
                )
                report["unsaved_human_edits_read_by_rtc_peer"] = True
                stage(report, "unsaved_human_edits")
                toolbar = panel.locator(".jp-Toolbar button")
                labels = await toolbar.evaluate_all(
                    "buttons => buttons.map(button => button.getAttribute('title') || button.getAttribute('aria-label') || '')"
                )
                report["toolbar_button_labels"] = labels
                run_indices = [
                    index
                    for index, label in enumerate(labels)
                    if label.startswith("Run ")
                ]
                require(
                    len(run_indices) == 1,
                    "Notebook toolbar does not have one unambiguous Run button",
                )
                report["ui_operations_performed"].append("Run")
                await toolbar.nth(run_indices[0]).click()

                async def human_request():
                    return next(
                        (
                            x
                            for x in execute_requests
                            if x["body"].get("metadata", {}).get("cell_id") == human_id
                        ),
                        None,
                    )

                human = await eventually(
                    human_request, "Lab Run reaching nbmodel execute API"
                )
                require(
                    human["body"]["code"] == edited_code,
                    "Lab Run submitted unexpected source",
                )
                require(
                    human["body"]["metadata"].get("document_path") == path,
                    "Lab Run lost Notebook path",
                )
                report["human_run_uses_nbmodel_execute"] = True
                report["human_run_metadata_keys"] = sorted(human["body"]["metadata"])

                async def human_saved():
                    value = await notebook(client, base, path)
                    return (
                        value
                        if value["cells"][0]["source"] == edited_note
                        and value["cells"][1]["source"] == edited_code
                        and "HUMAN_" + marker in outputs(value["cells"][1])
                        else None
                    )

                await eventually(
                    human_saved, "human edits and Run output saved by server"
                )
                sessions = await client.get(base + "/api/sessions")
                session = next(x for x in sessions.json() if x["path"] == path)
                kernel_id = session["kernel"]["id"]
                report["kernel_id"] = kernel_id
                report["ui_operations_performed"].append("close")
                await page.close()
            require(len(context.pages) == 0, "A Notebook page remained open")
            report["browser_pages_during_background_execution"] = 0
            report["rtc_probe_peer_during_background_execution"] = False
            stage(report, "all_notebook_pages_closed")
            disconnected_at = time.monotonic()

            async def room_lifetime_observed():
                deleted = (
                    "Room " + room + " deleted" in (root / "server.log").read_text()
                )
                if args.room_retention == "server":
                    require(
                        not deleted, "Server-retained room was unexpectedly deleted"
                    )
                return time.monotonic() - disconnected_at >= 61 and (
                    deleted if args.room_retention == "cleanup" else not deleted
                )

            await eventually(
                room_lifetime_observed, "configured server room lifetime", timeout=90
            )
            report["seconds_after_last_peer_disconnect"] = round(
                time.monotonic() - disconnected_at, 3
            )
            report["rtc_room_deleted_before_background_execution"] = (
                args.room_retention == "cleanup"
            )
            stage(
                report,
                "rtc_room_deleted"
                if args.room_retention == "cleanup"
                else "server_room_retained_without_clients",
            )

            submit = await client.post(
                base + "/api/kernels/" + kernel_id + "/execute",
                json={
                    "code": background_code,
                    "metadata": {
                        "document_id": room,
                        "document_path": path,
                        "cell_id": background_id,
                    },
                },
            )
            require(submit.status_code == 202, "Background execution was not accepted")
            request_id = submit.json()["request_id"]
            report["background_request_id"] = request_id
            result = await request_result(
                client, base + "/api/kernels/" + kernel_id + "/requests/" + request_id
            )
            report["background_execution"] = {
                "request_status": result.get("request_status"),
                "status": result.get("status"),
                "execution_count": result.get("execution_count"),
            }
            require(
                "BACKGROUND_" + marker in json.dumps(result),
                "Background response lacked its output",
            )
            report["background_response_contains_marker"] = True
            report["background_response_contains_svg"] = "image/svg+xml" in json.dumps(
                result
            )
            require(
                report["background_response_contains_svg"],
                "Background response lacked its SVG",
            )
            stage(report, "background_request_completed")

            async def background_saved():
                value = await notebook(client, base, path)
                cell = value["cells"][2]
                report["last_background_cell_output_count"] = len(
                    cell.get("outputs", [])
                )
                return (
                    value
                    if "BACKGROUND_" + marker in outputs(cell)
                    and "image/svg+xml" in outputs(cell)
                    else None
                )

            saved = await eventually(
                background_saved, "background stdout and SVG saved without Contents PUT"
            )
            require(
                saved["cells"][0]["source"] == edited_note
                and saved["cells"][1]["source"] == edited_code,
                "Background execution replaced human edits",
            )
            report["server_saved_background_outputs"] = True
            stage(report, "background_output_saved")

            reopened = await context.new_page()
            report["ui_operations_performed"].append("reopen")
            await reopened.goto(entrance)
            reopened_panel = reopened.locator(".jp-NotebookPanel").first
            await reopened_panel.wait_for(state="visible", timeout=60000)
            await (
                reopened_panel.locator(".jp-OutputArea")
                .filter(has_text="BACKGROUND_" + marker)
                .wait_for(state="visible", timeout=30000)
            )
            renderer = reopened_panel.locator(".jp-RenderedSVG")
            await renderer.wait_for(state="visible", timeout=30000)
            report["svg_renderer_text"] = (await renderer.text_content()).strip()
            require(
                "Cannot display an untrusted SVG" not in report["svg_renderer_text"],
                "Reopened Lab refused to display the server-executed SVG as untrusted",
            )
            # JupyterLab's pinned renderSVG implementation renders an img,
            # rather than inserting an inline svg node.
            svg = renderer.locator("img")
            await svg.wait_for(state="visible", timeout=30000)

            async def image_loaded():
                return await svg.evaluate(
                    "image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0"
                )

            await eventually(image_loaded, "SVG image load")
            expected_svg = next(
                output["data"]["image/svg+xml"]
                for output in saved["cells"][2]["outputs"]
                if "image/svg+xml" in output.get("data", {})
            )
            if isinstance(expected_svg, list):
                expected_svg = "".join(expected_svg)
            image_source = await svg.get_attribute("src")
            require(
                image_source.startswith("data:image/svg+xml,")
                and unquote(image_source.split(",", 1)[1]) == expected_svg,
                "Rendered SVG differs from the saved Notebook output",
            )
            report["rendered_svg_matches_saved_output"] = True
            require(
                edited_note.split("\n")[-1] in await reopened_panel.text_content(),
                "Reopened Lab lost human Markdown",
            )
            report["reopened_lab_outputs_visible"] = True
            if args.report:
                image_path = args.report.with_suffix(".png")
                image_path.parent.mkdir(parents=True, exist_ok=True)
                await svg.screenshot(path=str(image_path))
                report["chart_preview"] = str(image_path.resolve())

            before_export = await notebook(client, base, path)
            exported = await client.get(
                base + "/nbconvert/html/" + path + "?download=true"
            )
            require(exported.status_code == 200, "HTML export failed")
            csp = exported.headers.get("content-security-policy", "")
            sandbox = next(
                (
                    part.strip()
                    for part in csp.split(";")
                    if part.strip().startswith("sandbox")
                ),
                "",
            )
            require(
                bool(sandbox) and "allow-same-origin" not in sandbox.split(),
                "HTML export lacks an origin-isolating sandbox CSP",
            )
            require(
                "BACKGROUND_" + marker in exported.text
                and "Human explanation preserved " + marker in exported.text,
                "HTML export does not contain the verified Notebook's content",
            )
            after_export = await notebook(client, base, path)
            require(
                digest(before_export) == digest(after_export),
                "Notebook changed during HTML export",
            )
            report["export"] = {
                "notebook_sha256": digest(before_export),
                "html_sha256": hashlib.sha256(exported.content).hexdigest(),
                "content_security_policy": csp,
                "notebook_unchanged_during_export": True,
            }
            if args.report:
                args.report.with_suffix(".ipynb").write_text(
                    json.dumps(before_export, ensure_ascii=False, indent=2) + "\n"
                )
                args.report.with_suffix(".html").write_bytes(exported.content)
            await browser.close()
            browser = None
            stage(report, "reopen_and_export_verified")
    finally:
        try:
            if browser:
                await browser.close()
        except Exception:
            report["browser_cleanup_confirmed"] = False
        try:
            if process.poll() is None:
                sessions = await client.get(base + "/api/sessions")
                if sessions.status_code == 200:
                    for session in sessions.json():
                        await client.delete(base + "/api/sessions/" + session["id"])
                kernels = await client.get(base + "/api/kernels")
                if kernels.status_code == 200:
                    for kernel in kernels.json():
                        await client.delete(base + "/api/kernels/" + kernel["id"])
                remaining = await client.get(base + "/api/kernels")
                report["owned_kernels_after_cleanup"] = (
                    len(remaining.json()) if remaining.status_code == 200 else None
                )
        except Exception:
            report["api_cleanup_confirmed"] = False
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    await asyncio.to_thread(process.wait, timeout=20)
                except subprocess.TimeoutExpired:
                    process.kill()
                    await asyncio.to_thread(process.wait, timeout=5)
        await client.aclose()
        log.close()
        report["owned_server_stopped"] = process.poll() is not None
        report["nbmodel_missing_document_warnings"] = sum(
            "Document at path" in line and "not found." in line
            for line in (root / "server.log").read_text().splitlines()
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--room-retention",
        choices=("cleanup", "server"),
        default="cleanup",
        help="Compare standard 60-second cleanup with server-lifetime document retention",
    )
    parser.add_argument(
        "--unattended-bootstrap",
        action="store_true",
        help="Initialize through a transient RTC peer and execute without ever opening Lab",
    )
    parser.add_argument(
        "--output-recovery",
        action="store_true",
        help="Enable nbmodel recovery in this probe's isolated Lab settings",
    )
    parser.add_argument(
        "--chromium-executable",
        help="Optional existing Chromium executable; otherwise use Playwright's installed browser",
    )
    parser.add_argument(
        "--report",
        type=Path,
        help="Write JSON and Notebook evidence; Lab mode also writes HTML and chart preview",
    )
    args = parser.parse_args()
    report = {
        "status": "running",
        "stage": "versions",
        "scope": "isolated G0-B stack experiment",
        "python": sys.version.split()[0],
        "probe_source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }
    token = secrets.token_urlsafe(32)
    try:
        report["versions"] = {name: version(name) for name in VERSIONS}
        require(
            report["versions"] == VERSIONS,
            "Installed stack differs from requirements.txt",
        )
        with tempfile.TemporaryDirectory(prefix="disclaude-jupyter-g0-") as directory:
            root = Path(directory)
            try:
                asyncio.run(run_probe(args, root, token, report))
            finally:
                report["scratch_root"] = str(root)
        report["scratch_root_removed"] = not root.exists()
        require(
            report.get("owned_kernels_after_cleanup") == 0
            and report.get("owned_server_stopped"),
            "Owned resource cleanup was not verified",
        )
        require(
            report.get("contents_put_count") == 1,
            "Probe issued a Contents overwrite after creation",
        )
        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["errors"] = [
            detail.replace(token, "<redacted>") for detail in error_details(error)
        ]
        if "scratch_root" in report:
            report["scratch_root_removed"] = not Path(report["scratch_root"]).exists()
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False), flush=True)
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

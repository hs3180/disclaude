"""Reversible filesystem deployment in a selected Python/venv/conda environment."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
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


def systemctl(service: dict, *args: str) -> str:
    result = subprocess.run(["systemctl", *([] if service["system"] else ["--user"]),
                             *args, service["unit"]], capture_output=True, text=True)
    if result.returncode:
        raise EnvironmentError(f"Service operation {args[0]} failed (exit {result.returncode}); inspect status before retry")
    return result.stdout.strip()


def service_signature(service: dict) -> str:
    # Persist only a fingerprint: Environment/ExecStart may contain credentials.
    value = systemctl(service, "show", "--property=FragmentPath,DropInPaths,ExecStart,Environment,User")
    return fingerprint(value.encode())


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def require_stopped(plan: dict) -> None:
    runtime = Path(plan["target"]["runtimeDir"])
    for info in list(runtime.glob("jpserver-*.json")) + list(runtime.glob("nbserver-*.json")):
        try:
            pid = json.loads(info.read_text()).get("pid")
        except (OSError, ValueError):
            raise EnvironmentError("Cannot verify a Jupyter runtime record; stop the target server first")
        if isinstance(pid, int) and pid > 0 and alive(pid):
            raise EnvironmentError("A Jupyter server is still running in this runtime directory; no package files changed")
    # A custom runtime directory should not hide a server using this environment.
    # Linux process checks supplement runtime records, without reading/logging env.
    prefix = Path(plan["target"]["prefix"])
    executable = plan["target"]["python"]
    for process in Path("/proc").glob("[0-9]*"):
        if int(process.name) == os.getpid():
            continue
        try:
            args = (process / "cmdline").read_bytes().decode(errors="replace").split("\0")
        except OSError:
            continue
        if not args or not any("jupyter" in Path(arg).name.lower() for arg in args[:3]):
            continue
        same = args[0] == executable or any(
            Path(arg).is_absolute() and Path(arg).is_relative_to(prefix / "bin") for arg in args[:3])
        if same and alive(int(process.name)):
            raise EnvironmentError("A Jupyter process still uses this Python environment; no package files changed")


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
        if actual == item["originalSha256"]:
            positions.append("original")
        elif actual == item["candidateSha256"]:
            positions.append("candidate")
        else:
            raise EnvironmentError("Installed package/config changed outside this deployment; transition refused")
    service = plan.get("service")
    if service and service_signature(service) != plan["serviceSha256"]:
        raise EnvironmentError("Service definition/environment changed since prepare; transition refused")
    return positions


def prepare(root: Path, manifest_sha: str, state: Path, target: dict, service=None) -> dict:
    state.mkdir(parents=True, exist_ok=True)
    if state.is_symlink():
        raise EnvironmentError("Refuse a symlinked state directory")
    state.chmod(0o700)
    if (state / "plan.json").exists():
        plan = json.loads((state / "plan.json").read_text())
        if plan.get("deployment") != "environment" or plan["manifestSha256"] != manifest_sha or plan["target"] != target or plan.get("service") != service:
            raise EnvironmentError("State belongs to another patch/environment/service")
        verify(plan, state)
        return plan
    roots = {"python": Path(target["packageDir"]), "frontend": Path(target["frontendDir"])}
    writes, unchanged = install.plan_files(root, roots)
    if unchanged:
        raise EnvironmentError("Environment is already partially/patched; original rollback must come from its existing state")
    config = Path(target["configFile"])
    policy = json.loads((root / "server-config.json").read_text())
    writes += [(roots["python"] / "disclaude-repair.json", install.marker(root)),
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
            "target": target, "service": service, "files": [], "phase": "prepared"}
    if service:
        plan["serviceSha256"] = service_signature(service)
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


def transition(plan: dict, state: Path, action: str, restart: bool, stopped: bool) -> dict:
    service = plan.get("service")
    if not ((restart and service) or (stopped and not service)):
        raise EnvironmentError("Use --service UNIT --restart, or stop Jupyter externally and use --stopped")
    positions = verify(plan, state)
    expected = "candidate" if action == "apply" else "original"
    complete = all(position == expected for position in positions)
    finished = "applied" if action == "apply" else "rolled_back"
    # A failed start must not be mistaken for an idempotent successful activation.
    if complete and plan["phase"] == finished:
        active = systemctl(service, "show", "--property=ActiveState", "--value") if service else None
        if not service or active == "active":
            return {"action": action, "changed": False, "state": str(state), "phase": finished,
                    "activation": "service active; application verification required" if service else "restart externally required"}
    if service:
        plan["phase"] = action + "_stop_requested"
        save(state, plan)
        systemctl(service, "stop")
        if systemctl(service, "show", "--property=ActiveState", "--value") not in ("inactive", "failed"):
            raise EnvironmentError("Service is not stopped; no package files changed")
    require_stopped(plan)
    verify(plan, state)  # Recheck after stopping; never replace unknown file changes.
    plan["phase"] = action + "_requested"
    save(state, plan)
    for item in plan["files"]:
        path = Path(item["target"])
        if expected == "original" and item["original"] is None:
            path.unlink(missing_ok=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            atomic(path, (state / item[expected]).read_bytes(), item["mode"], item["owner"])
    if any(position != expected for position in verify(plan, state)):
        raise EnvironmentError("Installed files could not be verified; keep service stopped and inspect state")
    if service:
        plan["phase"] = action + "_start_requested"
        save(state, plan)
        systemctl(service, "start")
        if systemctl(service, "show", "--property=ActiveState", "--value") != "active":
            raise EnvironmentError("Service start is unconfirmed; inspect status, no automatic retry")
    plan["phase"] = finished
    save(state, plan)
    return {"action": action, "changed": not complete, "state": str(state), "phase": finished,
            "activation": "service active; application verification required" if service else "restart externally required"}


def status(plan: dict, state: Path) -> dict:
    positions = verify(plan, state)
    service = plan.get("service")
    return {"deployment": "environment", "phase": plan["phase"], "state": str(state),
            "files": positions, "target": plan["target"],
            "serviceState": systemctl(service, "show", "--property=ActiveState", "--value") if service else "externally managed",
            "applicationVerified": False}

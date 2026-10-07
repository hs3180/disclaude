"""Deploy to a selected Python environment or an existing Docker Compose Jupyter."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile


class DeploymentError(RuntimeError):
    pass


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: dict) -> None:
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(value, stream, indent=2)
        stream.write("\n")
    temporary.chmod(0o600)
    temporary.replace(path)


@contextmanager
def payload():
    archive_path = Path(sys.argv[0]).resolve()
    if not zipfile.is_zipfile(archive_path):
        root = Path(__file__).resolve().parent
        yield root, sha(root / "manifest.json")
        return
    with tempfile.TemporaryDirectory(prefix="datalayer-patch-") as temporary:
        root = Path(temporary)
        with zipfile.ZipFile(archive_path) as archive:
            index = json.loads(archive.read("index.json"))
            if index.get("schema") != 1 or set(archive.namelist()) != set(index["files"]) | {"index.json"}:
                raise DeploymentError("Invalid patch archive inventory")
            for name, digest in index["files"].items():
                path = PurePosixPath(name)
                if path.is_absolute() or any(part in ("..", ".") for part in path.parts):
                    raise DeploymentError("Invalid patch archive path")
                data = archive.read(name)
                if hashlib.sha256(data).hexdigest() != digest:
                    raise DeploymentError("Patch archive checksum differs")
                if name.startswith("payload/"):
                    target = root / name.removeprefix("payload/")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
        if sha(root / "manifest.json") != index["manifestSha256"]:
            raise DeploymentError("Patch manifest checksum differs")
        yield root, index["manifestSha256"]


def docker(*args: str) -> str:
    result = subprocess.run(["docker", *args], capture_output=True, text=True)
    if result.returncode:
        # Compose output can contain resolved deployment secrets. Never echo it.
        detail = ": " + result.stderr[-2000:] if args[0] == "build" else ""
        raise DeploymentError(f"Docker {args[0]} failed (exit {result.returncode}); no automatic retry{detail}")
    return result.stdout


def inspect_container(name: str) -> dict:
    template = ('{"id":{{json .Id}},"image":{{json .Image}},"user":{{json .Config.User}},'
                '"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"state":{{json .State}}}')
    return json.loads(docker("inspect", "--format", template, name))


def compose(plan: dict, override: str | None = None) -> list[str]:
    command = ["compose", "--project-directory", plan["directory"], "-p", plan["project"]]
    for filename in plan["composeFiles"] + ([override] if override else []):
        command.extend(["-f", filename])
    return command


def config_target(plan: dict) -> str:
    if "configTarget" in plan:
        return plan["configTarget"]
    # Schema-1 preparations already recorded the actual mount target in their
    # override. Preserve their rollback without any old directory literal.
    value = json.loads(Path(plan["applyOverride"]).read_text())
    return value["services"][plan["service"]]["volumes"][0]["target"]


def check_compose_merge(plan: dict, override: str) -> None:
    original = json.loads(docker(*compose(plan), "config", "--format", "json"))
    candidate = json.loads(docker(*compose(plan, override), "config", "--format", "json"))
    for value in (original, candidate):
        service = value["services"][plan["service"]]
        service.pop("image", None)
        service["volumes"] = [v for v in service.get("volumes", []) if v["target"] != config_target(plan)]
    if original != candidate:
        raise DeploymentError("Compose override changes fields other than the target image/config mount")


def override(plan: dict, image: str, config: str) -> dict:
    return {"services": {plan["service"]: {"image": image, "volumes": [
        {"type": "bind", "source": config, "target": config_target(plan), "read_only": True}
    ]}}}


def check_inputs(plan: dict) -> None:
    for filename, digest in plan["inputs"].items():
        path = Path(filename)
        if not path.is_file() or path.is_symlink() or sha(path) != digest:
            raise DeploymentError("Saved deployment input changed; preserve it and prepare a separate state directory")
    for filename, digest in plan["outputs"].items():
        if sha(Path(filename)) != digest:
            raise DeploymentError("Prepared deployment file changed; transition refused")
    if "composeConfigSha256" in plan:
        resolved = json.loads(docker(*compose(plan), "config", "--format", "json"))
        digest = hashlib.sha256(json.dumps(resolved, sort_keys=True).encode()).hexdigest()
        if digest != plan["composeConfigSha256"]:
            raise DeploymentError("Resolved Compose inputs changed, including environment interpolation")


def check_identity(plan: dict, container: dict) -> None:
    labels = container["labels"] or {}
    if labels.get("com.docker.compose.project") != plan["project"] or labels.get("com.docker.compose.service") != plan["service"]:
        raise DeploymentError("Container no longer belongs to the original Compose service")
    if container["image"] not in (plan["originalImage"], plan["candidateImage"]):
        raise DeploymentError("Container image changed outside this deployment; transition refused")
    if "originalMounts" in plan and stable_mounts(container, config_target(plan)) != plan["originalMounts"]:
        raise DeploymentError("Container data mounts changed outside this deployment; transition refused")


def stable_mounts(container: dict, target: str) -> list:
    return sorted([[m["Type"], m["Source"], m["Destination"], m["RW"]]
                   for m in container["mounts"] if m["Destination"] != target])


def check_file_ids(config: dict, container: dict) -> None:
    value = config.get("BaseFileIdManager", {}).get("db_path")
    if isinstance(value, str) and PurePosixPath(value).is_absolute():
        parent = PurePosixPath(value).parent
        for mount in container["mounts"]:
            if mount["Type"] in ("bind", "volume") and mount["RW"] and parent.is_relative_to(PurePosixPath(mount["Destination"])):
                return
    raise DeploymentError("Native file-ID database needs an explicit db_path inside a persistent directory mount before image replacement")


def prepare(root: Path, manifest_sha: str, name: str, state: Path, python="python3", config_file=None, frontend_dir=None) -> dict:
    state.mkdir(parents=True, exist_ok=True)
    if state.is_symlink():
        raise DeploymentError("Refuse a symlinked state directory")
    state.chmod(0o700)
    saved = state / "plan.json"
    container = inspect_container(name)
    if saved.exists():
        plan = json.loads(saved.read_text())
        if plan["manifestSha256"] != manifest_sha or plan["container"] != name:
            raise DeploymentError("State belongs to another patch/container")
        check_inputs(plan)
        check_identity(plan, container)
        if config_file and config_target(plan) != str(config_file):
            raise DeploymentError("Saved preparation uses another configuration path")
        if "target" in plan and (frontend_dir and plan["target"]["frontendDir"] != str(frontend_dir)):
            raise DeploymentError("Saved preparation uses another Lab extension path")
        return plan
    labels = container["labels"] or {}
    directory = labels.get("com.docker.compose.project.working_dir")
    files = labels.get("com.docker.compose.project.config_files", "").split(",")
    if not directory or not labels.get("com.docker.compose.service") or not labels.get("com.docker.compose.project") or not all(files):
        raise DeploymentError("Expected an existing Docker Compose container")
    files = [str(Path(filename).resolve()) for filename in files]
    if any(not Path(filename).is_file() or Path(filename).is_symlink() for filename in files):
        raise DeploymentError("Compose source files must be readable regular files")
    arguments = []
    if config_file:
        arguments += ["--config-file", str(config_file)]
    if frontend_dir:
        arguments += ["--frontend-dir", str(frontend_dir)]
    target = json.loads(docker("exec", name, python, "-c", (root / "discovery.py").read_text(), *arguments))
    config_path = target["configFile"]
    original_config = state / ("original-config" + Path(config_path).suffix)
    # Reading via the runtime user honors its permissions and supports a new
    # standard config file. Nothing is written into the live container.
    encoded = docker("exec", name, target["python"], "-c",
                     "import base64,json,pathlib,sys; p=pathlib.Path(sys.argv[1]); "
                     "print(json.dumps(base64.b64encode(p.read_bytes()).decode() if p.exists() else None))", config_path)
    import base64
    original_bytes = json.loads(encoded)
    original_config.write_bytes(base64.b64decode(original_bytes) if original_bytes is not None else b"{}\n" if original_config.suffix == ".json" else b"")
    # Load effective traits privately, rather than assuming file IDs are in JSON.
    # Custom startup --config paths must be explicitly selected by the operator.
    original_settings = json.loads(docker("exec", name, target["python"], "-c",
        "import json,sys; from jupyter_server.serverapp import ServerApp; "
        "app=ServerApp(); app.load_config_file(sys.argv[1]); print(json.dumps(dict(app.config)))", config_path))
    check_file_ids(original_settings, container)
    original_config.chmod(0o644)
    mounted = next((m for m in container["mounts"] if m["Destination"] == config_path), None)
    if mounted and (mounted["Type"] != "bind" or not Path(mounted["Source"]).is_file() or Path(mounted["Source"]).is_symlink()):
        raise DeploymentError("Expected a regular bind-mounted shared config")
    rollback_config = mounted["Source"] if mounted else str(original_config)
    candidate_config = state / ("candidate-config" + Path(config_path).suffix)
    shutil.copyfile(original_config, candidate_config)
    subprocess.run([sys.executable, str(root / "configure.py"), "--config-file", str(candidate_config)],
                   check=True, capture_output=True)
    candidate_config.chmod(0o644)  # Private parent; readable by the existing container UID.
    plan = {"schema": 2, "deployment": "compose", "target": target, "configTarget": config_path,
            "container": name, "manifestSha256": manifest_sha,
            "directory": directory, "composeFiles": files,
            "project": labels["com.docker.compose.project"],
            "service": labels["com.docker.compose.service"], "originalImage": container["image"],
            "originalMounts": stable_mounts(container, config_path),
            "candidateTag": f"disclaude-datalayer-repair:{manifest_sha[:12]}-{container['image'].split(':')[-1][:12]}",
            "inputs": {filename: sha(Path(filename)) for filename in files}, "outputs": {},
            "phase": "prepared"}
    if mounted:
        plan["inputs"][mounted["Source"]] = sha(Path(mounted["Source"]))
    resolved = json.loads(docker(*compose(plan), "config", "--format", "json"))
    plan["composeConfigSha256"] = hashlib.sha256(json.dumps(resolved, sort_keys=True).encode()).hexdigest()
    replicas = docker(*compose(plan), "ps", "--all", "-q", plan["service"]).split()
    if len(replicas) != 1:
        raise DeploymentError("Expected exactly one container for the target Compose service")
    print("Building the patch image; the running service remains in place.", flush=True)
    # BuildKit treats a raw sha256:ID in FROM as a registry repository/tag.
    # Give the already present immutable image a local name, then verify it.
    base_tag = "disclaude-datalayer-base:" + container["image"].split(":")[-1]
    docker("tag", container["image"], base_tag)
    if json.loads(docker("image", "inspect", "--format", "{{json .Id}}", base_tag)) != container["image"]:
        raise DeploymentError("Local base-image tag cannot be verified")
    docker("build", "--build-arg", f"JUPYTER_BASE_IMAGE={base_tag}", "--build-arg",
           f"JUPYTER_RUNTIME_USER={container['user'] or 'root'}", "--build-arg", f"JUPYTER_PYTHON={target['python']}",
           "--build-arg", f"JUPYTER_FRONTEND_DIR={target['frontendDir']}", "--build-arg", f"JUPYTER_PACKAGE_DIR={target['packageDir']}",
           "--build-arg", f"JUPYTER_PACKAGE_PARENT={Path(target['packageDir']).parent}", "-t", plan["candidateTag"], str(root))
    plan["candidateImage"] = json.loads(docker("image", "inspect", "--format", "{{json .Id}}", plan["candidateTag"]))
    verification = json.loads(docker("run", "--rm", "--network", "none", "--entrypoint", target["python"],
                                    plan["candidateImage"], "/opt/disclaude/datalayer-repair/install.py", "--check",
                                    "--package-dir", target["packageDir"], "--frontend-dir", target["frontendDir"]))
    if verification["pendingFiles"] != 0 or verification["alreadyAppliedFiles"] != 8 or verification["manifestSha256"] != manifest_sha:
        raise DeploymentError("Candidate overlay verification failed")
    for action, image, config in [("apply", plan["candidateImage"], str(candidate_config)),
                                  ("rollback", plan["originalImage"], rollback_config)]:
        filename = state / f"compose-{action}.json"
        value = override(plan, image, config)
        if action == "rollback" and mounted:
            value["services"][plan["service"]]["volumes"][0]["read_only"] = not mounted["RW"]
        write_json(filename, value)
        plan[action + "Override"] = str(filename)
        check_compose_merge(plan, str(filename))
        plan["outputs"][str(filename)] = sha(filename)
    for filename in (original_config, candidate_config):
        plan["outputs"][str(filename)] = sha(filename)
    check_inputs(plan)
    # Recheck the original after the build; no unnoticed deployment switch is accepted.
    if inspect_container(name)["id"] != container["id"]:
        raise DeploymentError("Original container changed during preparation")
    write_json(saved, plan)
    return plan


def transition(plan: dict, state: Path, action: str, restart: bool) -> dict:
    if not restart:
        raise DeploymentError("Prepared only. Save/close kernels, then repeat with --restart to recreate Jupyter")
    check_inputs(plan)
    current = inspect_container(plan["container"])
    check_identity(plan, current)
    target = plan["candidateImage"] if action == "apply" else plan["originalImage"]
    filename = plan[action + "Override"]
    expected_config = json.loads(Path(filename).read_text())["services"][plan["service"]]["volumes"][0]["source"]
    if current["image"] == target and any(m["Destination"] == config_target(plan) and m["Source"] == expected_config for m in current["mounts"]):
        return {"action": action, "changed": False, "state": str(state), "image": target}
    check_compose_merge(plan, filename)
    plan["phase"] = action + "_requested"
    write_json(state / "plan.json", plan)
    docker(*compose(plan, filename), "up", "-d", "--no-deps", "--no-build", "--pull", "never", plan["service"])
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        actual = inspect_container(plan["container"])
        health = actual["state"].get("Health", {}).get("Status")
        if actual["image"] == target and actual["state"].get("Status") == "running" and health in (None, "healthy"):
            break
        time.sleep(1)
    else:
        raise DeploymentError("Service health unconfirmed; inspect status or explicitly roll back, no automatic retry")
    if not any(m["Destination"] == config_target(plan) and m["Source"] == expected_config for m in actual["mounts"]):
        raise DeploymentError("Applied config mount cannot be verified")
    plan["phase"] = "applied" if action == "apply" else "rolled_back"
    write_json(state / "plan.json", plan)
    return {"action": action, "changed": True, "state": str(state), "image": target,
            "health": health or "no Docker healthcheck; application verification still required"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["info", "prepare", "apply", "rollback", "status"])
    parser.add_argument("--container", help="Select Compose deployment; no default container")
    parser.add_argument("--python", default="python3", help="Interpreter in the selected container")
    parser.add_argument("--config-file", type=Path)
    parser.add_argument("--frontend-dir", type=Path)
    parser.add_argument("--package-dir", type=Path, help="Owned staging override for component tests")
    parser.add_argument("--service", help="Existing systemd unit for plain-environment stop/start")
    parser.add_argument("--system", action="store_true", help="System systemd unit rather than user unit")
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--restart", action="store_true")
    parser.add_argument("--stopped", action="store_true", help="Externally stopped plain-environment server")
    args = parser.parse_args()
    if args.container and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", args.container):
        parser.error("Expected a Docker container name or ID")
    if args.service and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@-]*\.service", args.service):
        parser.error("Expected a systemd .service unit name")
    if (args.container and (args.service or args.system or args.stopped or args.package_dir)) or (args.system and not args.service):
        parser.error("Service/stopped options target a plain environment; --system requires --service")
    if args.restart and args.stopped:
        parser.error("Choose --restart or --stopped")
    if args.action in ("apply", "rollback"):
        if args.container and not args.restart:
            parser.error("Compose apply/rollback requires --restart")
        if not args.container and not ((args.service and args.restart) or (not args.service and args.stopped)):
            parser.error("Use --service UNIT --restart, or stop Jupyter externally and use --stopped")
    elif args.restart or args.stopped:
        parser.error("--restart/--stopped is only for apply/rollback")
    try:
        with payload() as (root, digest):
            if args.action == "info":
                print(json.dumps({"manifestSha256": digest, "revision": json.loads((root / "manifest.json").read_text())["revision"]}))
                return
            sys.path.insert(0, str(root))
            import environment
            service = {"unit": args.service, "system": args.system} if args.service else None
            if args.container:
                target = None
                identity = args.container
            else:
                target = environment.discover(args.config_file, args.frontend_dir, args.package_dir)
                identity = "environment-" + hashlib.sha256(json.dumps({"target": target, "service": service}, sort_keys=True).encode()).hexdigest()[:16]
            requested_state = args.state_dir or Path.home() / ".local/state/disclaude-datalayer-patch" / identity
            if not requested_state.is_absolute() or requested_state.is_symlink():
                raise DeploymentError("State directory must be an absolute, non-symlink path")
            state = requested_state.resolve()
            if args.action in ("prepare", "apply"):
                if args.container:
                    plan = prepare(root, digest, args.container, state, args.python, args.config_file, args.frontend_dir)
                else:
                    plan = environment.prepare(root, digest, state, target, service)
            else:
                plan = json.loads((state / "plan.json").read_text())
                if plan["manifestSha256"] != digest:
                    raise DeploymentError("State belongs to another patch")
                if args.container:
                    if plan.get("container") != args.container or plan.get("deployment") == "environment":
                        raise DeploymentError("State belongs to another container/deployment")
                elif plan.get("deployment") != "environment" or plan["target"] != target or plan.get("service") != service:
                    raise DeploymentError("State belongs to another environment/service")
            if args.action in ("apply", "rollback"):
                result = transition(plan, state, args.action, args.restart) if args.container else environment.transition(plan, state, args.action, args.restart, args.stopped)
            elif args.action == "status":
                if args.container:
                    current = inspect_container(args.container)
                    check_inputs(plan)
                    check_identity(plan, current)
                    result = {"deployment": "compose", "phase": plan["phase"], "image": current["image"], "state": str(state), "configFile": config_target(plan)}
                else:
                    result = environment.status(plan, state)
            else:
                result = {"action": "prepared", "deployment": "compose" if args.container else "environment",
                          "state": str(state), "manifestSha256": digest,
                          **({"candidateImage": plan["candidateImage"], "service": plan["service"], "configFile": config_target(plan)} if args.container else {"target": target, "service": service})}
            print(json.dumps(result))
    except (RuntimeError, OSError, ValueError, KeyError, ImportError, subprocess.CalledProcessError) as error:
        print(f"Patch deployment refused: {error}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()

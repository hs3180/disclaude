"""Prepare, apply and roll back the pinned overlay on an existing Docker Compose Jupyter."""

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


CONFIG_TARGET = "/opt/conda/etc/jupyter/jupyter_config.json"


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


def check_compose_merge(plan: dict, override: str) -> None:
    original = json.loads(docker(*compose(plan), "config", "--format", "json"))
    candidate = json.loads(docker(*compose(plan, override), "config", "--format", "json"))
    for value in (original, candidate):
        service = value["services"][plan["service"]]
        service.pop("image", None)
        service["volumes"] = [v for v in service.get("volumes", []) if v["target"] != CONFIG_TARGET]
    if original != candidate:
        raise DeploymentError("Compose override changes fields other than the target image/config mount")


def override(plan: dict, image: str, config: str) -> dict:
    return {"services": {plan["service"]: {"image": image, "volumes": [
        {"type": "bind", "source": config, "target": CONFIG_TARGET, "read_only": True}
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
    if "originalMounts" in plan and stable_mounts(container) != plan["originalMounts"]:
        raise DeploymentError("Container data mounts changed outside this deployment; transition refused")


def stable_mounts(container: dict) -> list:
    return sorted([[m["Type"], m["Source"], m["Destination"], m["RW"]]
                   for m in container["mounts"] if m["Destination"] != CONFIG_TARGET])


def check_file_ids(config: dict, container: dict) -> None:
    value = config.get("BaseFileIdManager", {}).get("db_path")
    if isinstance(value, str) and PurePosixPath(value).is_absolute():
        parent = PurePosixPath(value).parent
        for mount in container["mounts"]:
            if mount["Type"] in ("bind", "volume") and mount["RW"] and parent.is_relative_to(PurePosixPath(mount["Destination"])):
                return
    raise DeploymentError("Native file-ID database needs an explicit db_path inside a persistent directory mount before image replacement")


def prepare(root: Path, manifest_sha: str, name: str, state: Path) -> dict:
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
        return plan
    labels = container["labels"] or {}
    directory = labels.get("com.docker.compose.project.working_dir")
    files = labels.get("com.docker.compose.project.config_files", "").split(",")
    if not directory or not labels.get("com.docker.compose.service") or not labels.get("com.docker.compose.project") or not all(files):
        raise DeploymentError("Expected an existing Docker Compose container")
    files = [str(Path(filename).resolve()) for filename in files]
    if any(not Path(filename).is_file() or Path(filename).is_symlink() for filename in files):
        raise DeploymentError("Compose source files must be readable regular files")
    original_config = state / "original-config.json"
    docker("cp", f"{name}:{CONFIG_TARGET}", str(original_config))
    original_settings = json.loads(original_config.read_text())
    if not isinstance(original_settings, dict):
        raise DeploymentError("Expected a shared JSON Jupyter configuration")
    check_file_ids(original_settings, container)
    original_config.chmod(0o644)
    mounted = next((m for m in container["mounts"] if m["Destination"] == CONFIG_TARGET), None)
    if mounted and (mounted["Type"] != "bind" or not Path(mounted["Source"]).is_file() or Path(mounted["Source"]).is_symlink()):
        raise DeploymentError("Expected a regular bind-mounted shared config")
    rollback_config = mounted["Source"] if mounted else str(original_config)
    candidate_config = state / "candidate-config.json"
    shutil.copyfile(original_config, candidate_config)
    subprocess.run([sys.executable, str(root / "configure.py"), "--config-file", str(candidate_config)],
                   check=True, capture_output=True)
    candidate_config.chmod(0o644)  # Private parent; readable by the existing container UID.
    plan = {"schema": 1, "container": name, "manifestSha256": manifest_sha,
            "directory": directory, "composeFiles": files,
            "project": labels["com.docker.compose.project"],
            "service": labels["com.docker.compose.service"], "originalImage": container["image"],
            "originalMounts": stable_mounts(container),
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
           f"JUPYTER_RUNTIME_USER={container['user'] or 'root'}", "-t", plan["candidateTag"], str(root))
    plan["candidateImage"] = json.loads(docker("image", "inspect", "--format", "{{json .Id}}", plan["candidateTag"]))
    verification = json.loads(docker("run", "--rm", "--network", "none", "--entrypoint", "python",
                                    plan["candidateImage"], "/opt/disclaude/datalayer-repair/install.py", "--check"))
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
    if current["image"] == target and any(m["Destination"] == CONFIG_TARGET and m["Source"] == expected_config for m in current["mounts"]):
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
    if not any(m["Destination"] == CONFIG_TARGET and m["Source"] == expected_config for m in actual["mounts"]):
        raise DeploymentError("Applied config mount cannot be verified")
    plan["phase"] = "applied" if action == "apply" else "rolled_back"
    write_json(state / "plan.json", plan)
    return {"action": action, "changed": True, "state": str(state), "image": target,
            "health": health or "no Docker healthcheck; application verification still required"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["info", "prepare", "apply", "rollback", "status"])
    parser.add_argument("--container", default="jupyter-gpu-1")
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--restart", action="store_true", help="Recreate only this Jupyter service; existing kernels end")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", args.container):
        parser.error("Expected a Docker container name or ID")
    requested_state = args.state_dir or Path.home() / ".local/state/disclaude-datalayer-patch" / args.container
    if requested_state.is_symlink():
        parser.error("Refuse a symlinked state directory")
    state = requested_state.resolve()
    try:
        with payload() as (root, digest):
            if args.action == "info":
                print(json.dumps({"manifestSha256": digest, "revision": json.loads((root / "manifest.json").read_text())["revision"]}))
                return
            if args.action in ("prepare", "apply"):
                plan = prepare(root, digest, args.container, state)
            else:
                plan = json.loads((state / "plan.json").read_text())
                if plan["manifestSha256"] != digest or plan["container"] != args.container:
                    raise DeploymentError("State belongs to another patch/container")
            if args.action in ("apply", "rollback"):
                result = transition(plan, state, args.action, args.restart)
            elif args.action == "status":
                current = inspect_container(args.container)
                result = {"phase": plan["phase"], "image": current["image"], "state": str(state)}
            else:
                result = {"action": "prepared", "state": str(state), "candidateImage": plan["candidateImage"],
                          "manifestSha256": digest, "service": plan["service"]}
            print(json.dumps(result))
    except (DeploymentError, OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"Patch deployment refused: {error}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()

"""Install the repair in the Jupyter Terminal Python environment."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import tempfile
import zipfile


class DeploymentError(RuntimeError):
    pass


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["info", "prepare", "apply", "rollback", "status"])
    parser.add_argument("--config-file", type=Path)
    parser.add_argument("--frontend-dir", type=Path)
    parser.add_argument("--package-dir", type=Path, help="Owned staging override for component tests")
    parser.add_argument("--state-dir", type=Path)
    args = parser.parse_args()
    try:
        with payload() as (root, digest):
            if args.action == "info":
                print(json.dumps({"manifestSha256": digest, "revision": json.loads((root / "manifest.json").read_text())["revision"]}))
                return
            sys.path.insert(0, str(root))
            import environment
            target = environment.discover(args.config_file, args.frontend_dir, args.package_dir)
            identity = "environment-" + hashlib.sha256(json.dumps(target, sort_keys=True).encode()).hexdigest()[:16]
            requested_state = args.state_dir or Path.home() / ".local/state/disclaude-datalayer-patch" / identity
            if not requested_state.is_absolute() or requested_state.is_symlink():
                raise DeploymentError("State directory must be an absolute, non-symlink path")
            state = requested_state.resolve()
            if args.action in ("prepare", "apply"):
                plan = environment.prepare(root, digest, state, target)
            else:
                plan = json.loads((state / "plan.json").read_text())
                if plan["manifestSha256"] != digest:
                    raise DeploymentError("State belongs to another patch")
                if plan.get("deployment") != "environment" or plan["target"] != target or plan.get("service"):
                    raise DeploymentError("State belongs to another installation")
            if args.action in ("apply", "rollback"):
                result = environment.transition(plan, state, args.action)
            elif args.action == "status":
                result = environment.status(plan, state)
            else:
                result = {"action": "prepared", "deployment": "environment", "state": str(state),
                          "manifestSha256": digest, "target": target, "filesChanged": False}
            print(json.dumps(result))
    except (RuntimeError, OSError, ValueError, KeyError, ImportError) as error:
        print(f"Patch installation refused: {error}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()

"""Verify and stage the pinned nbmodel repair in the selected Python environment."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
from importlib.metadata import version
import json
from pathlib import Path
import re
import tempfile


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_path(root: Path, relative: str) -> Path:
    if not relative or relative.startswith("/") or any(part in ("", ".", "..") for part in relative.split("/")):
        raise ValueError("Invalid overlay path")
    result = root / relative
    if not result.resolve().is_relative_to(root.resolve()) or result.is_symlink():
        raise ValueError("Overlay path escaped its target")
    return result


def patched_text(original: str, patch: str) -> str:
    """Apply one exact unified diff with strict hunk/content validation."""
    source = original.splitlines(keepends=True)
    lines = []
    for line in patch.splitlines(keepends=True):
        if line.startswith("\\ No newline at end of file"):
            if not lines:
                raise ValueError("Invalid overlay newline marker")
            lines[-1] = lines[-1].removesuffix("\n")
        else:
            lines.append(line)
    output = []
    cursor = 0
    index = 0
    hunks = 0
    while index < len(lines):
        line = lines[index]
        if not line.startswith("@@"):
            index += 1
            continue
        match = re.fullmatch(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*\n", line)
        if match is None:
            raise ValueError("Invalid overlay hunk")
        start = int(match[1]) - 1
        old_count = int(match[2] or 1)
        new_count = int(match[4] or 1)
        if start < cursor or start > len(source):
            raise ValueError("Overlay hunks are out of order")
        output.extend(source[cursor:start])
        cursor = start
        used_old = used_new = 0
        index += 1
        while used_old < old_count or used_new < new_count:
            if index >= len(lines):
                raise ValueError("Incomplete overlay hunk")
            row = lines[index]
            index += 1
            if row[0] in (" ", "-"):
                if cursor >= len(source) or source[cursor] != row[1:]:
                    raise ValueError(f"Overlay source context differs at line {cursor + 1}")
                cursor += 1
                used_old += 1
            if row[0] in (" ", "+"):
                output.append(row[1:])
                used_new += 1
            if row[0] not in (" ", "-", "+"):
                raise ValueError("Invalid overlay hunk row")
        if used_old != old_count or used_new != new_count:
            raise ValueError("Overlay hunk lengths differ")
        hunks += 1
    if not hunks:
        raise ValueError("Overlay contains no hunks")
    output.extend(source[cursor:])
    return "".join(output)


def replace_file(path: Path, data: bytes) -> None:
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".nbmodel-repair-", delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(data)
        stream.flush()
    temporary.chmod(path.stat().st_mode & 0o777 if path.exists() else 0o644)
    temporary.replace(path)


def targets(package_dir: Path | None = None, frontend_dir: Path | None = None) -> dict:
    """Use the target interpreter and Jupyter's data search path, never a prefix literal."""
    spec = importlib.util.find_spec("jupyter_server_nbmodel")
    if package_dir is None and (spec is None or spec.origin is None):
        raise RuntimeError("nbmodel is not installed in the selected Python environment")
    package = package_dir or Path(spec.origin).parent
    if frontend_dir:
        frontend = frontend_dir
    else:
        from jupyter_core.paths import jupyter_path
        installed = [Path(root) / "@datalayer/jupyter-server-nbmodel" for root in jupyter_path("labextensions")]
        installed = [path for path in installed if (path / "package.json").is_file()]
        if len(installed) != 1:
            raise RuntimeError("Exactly one pinned nbmodel Lab bundle is required; select --frontend-dir explicitly")
        frontend = installed[0]
    return {"python": package.resolve(), "frontend": frontend.resolve()}


def plan_files(overlay: Path, roots: dict) -> tuple[list, int]:
    manifest = json.loads((overlay / "manifest.json").read_text())
    if manifest.get("schema") != 1 or version("jupyter-server-nbmodel") != manifest["nbmodelVersion"]:
        raise RuntimeError("Overlay requires its pinned nbmodel version")
    frontend_metadata = json.loads((roots["frontend"] / "package.json").read_text())
    if frontend_metadata.get("version") != manifest["frontendVersion"]:
        raise RuntimeError("Overlay requires its pinned nbmodel Lab version")
    writes = []
    unchanged = 0
    for item in manifest["changes"]:
        root = roots[item["area"]]
        source = safe_path(root, item["source"])
        target = safe_path(root, item["target"])
        if target.exists() and digest(target.read_bytes()) == item["patchedSha256"]:
            unchanged += 1
            continue
        before = source.read_bytes()
        if digest(before) != item["originalSha256"]:
            raise RuntimeError(f"Pinned source hash differs: {item['area']}/{item['source']}")
        patch = safe_path(overlay, item["patch"]).read_text()
        try:
            after = patched_text(before.decode("utf-8"), patch).encode("utf-8")
        except ValueError as error:
            raise RuntimeError(f"Overlay rejected {item['area']}/{item['source']}: {error}") from error
        if digest(after) != item["patchedSha256"]:
            raise RuntimeError("Patched source fingerprint differs")
        if item["area"] == "python":
            compile(after, str(target), "exec")
        if target != source and target.exists():
            raise RuntimeError("Unknown file occupies the overlay target")
        writes.append((target, after))
    for item in manifest["additions"]:
        target = safe_path(roots[item["area"]], item["target"])
        after = safe_path(overlay, item["file"]).read_bytes()
        if digest(after) != item["sha256"]:
            raise RuntimeError("Overlay module fingerprint differs")
        compile(after, str(target), "exec")
        if target.exists():
            if digest(target.read_bytes()) != item["sha256"]:
                raise RuntimeError("Unknown existing repair module")
            unchanged += 1
        else:
            writes.append((target, after))
    return writes, unchanged


def marker(overlay: Path) -> bytes:
    manifest = json.loads((overlay / "manifest.json").read_text())
    return (json.dumps({"manifestSha256": digest((overlay / "manifest.json").read_bytes()),
                       "revision": manifest["revision"], "changes": manifest["changes"]}, indent=2) + "\n").encode()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-dir", type=Path)
    parser.add_argument("--frontend-dir", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    overlay = Path(__file__).resolve().parent
    roots = targets(args.package_dir, args.frontend_dir)
    writes, unchanged = plan_files(overlay, roots)
    manifest = json.loads((overlay / "manifest.json").read_text())
    if not args.check:
        # All sources, contexts, fingerprints and syntax were checked first.
        # The deployment adapter stops the service before applying to an environment.
        for target, after in writes:
            replace_file(target, after)
        replace_file(roots["python"] / "disclaude-repair.json", marker(overlay))
    print(json.dumps({"mode": "check" if args.check else "applied", "revision": manifest["revision"],
                      "pendingFiles": len(writes), "alreadyAppliedFiles": unchanged,
                      "manifestSha256": digest((overlay / "manifest.json").read_bytes())}))


if __name__ == "__main__":
    main()

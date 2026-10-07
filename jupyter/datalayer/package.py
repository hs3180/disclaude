"""Build a standalone remote-Docker patch tool using only the Python stdlib."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import zipfile


def build(target: Path) -> dict:
    source = Path(__file__).resolve().parent
    manifest = json.loads((source / "manifest.json").read_text())
    names = ["Dockerfile", "install.py", "configure.py", "manifest.json", "runtime.py",
             "server-config.json", "reporting-requirements.txt", "LICENSE.nbmodel",
             "frontend-source.patch"]
    names.extend(item["patch"] for item in manifest["changes"])
    files = {"__main__.py": b"from deploy import main\nmain()\n",
             "deploy.py": (source / "deploy.py").read_bytes()}
    for name in names:
        path = source / name
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(source):
            raise RuntimeError("Invalid patch package input")
        files["payload/" + name] = path.read_bytes()
    index = {"schema": 1, "revision": manifest["revision"],
             "manifestSha256": hashlib.sha256(files["payload/manifest.json"]).hexdigest(),
             "files": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}}
    files["index.json"] = (json.dumps(index, sort_keys=True, indent=2) + "\n").encode()
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("wb") as stream:
        stream.write(b"#!/usr/bin/env python3\n")
        with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in sorted(files.items()):
                entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.external_attr = 0o100644 << 16
                archive.writestr(entry, data)
    target.chmod(0o755)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    target.with_suffix(target.suffix + ".sha256").write_text(f"{digest}  {target.name}\n")
    return {"artifact": str(target), "sha256": digest, "bytes": target.stat().st_size,
            "revision": index["revision"], "manifestSha256": index["manifestSha256"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    print(json.dumps(build(parser.parse_args().output)))

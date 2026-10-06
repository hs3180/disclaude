"""Merge repair traits into the shared config loaded by Lab/Server applications."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import tempfile


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config-file", required=True, type=Path)
    target = parser.parse_args().config_file
    if target.is_symlink():
        raise RuntimeError("Refuse a symlinked configuration target")
    current = json.loads(target.read_text()) if target.exists() else {}
    if not isinstance(current, dict):
        raise RuntimeError("Invalid existing Jupyter configuration")
    policy = json.loads((Path(__file__).parent / "server-config.json").read_text())
    for section, traits in policy.items():
        previous = current.get(section, {})
        if not isinstance(previous, dict):
            raise RuntimeError("Invalid existing Jupyter trait section")
        current[section] = {**previous, **traits}
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=target.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(json.dumps(current, indent=2) + "\n")
    temporary.chmod(target.stat().st_mode & 0o777 if target.exists() else 0o644)
    temporary.replace(target)


if __name__ == "__main__":
    main()

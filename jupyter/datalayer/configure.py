"""Merge repair traits into the shared config loaded by Lab/Server applications."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import tempfile


def configured_bytes(target: Path, policy: dict) -> bytes:
    """Preserve existing settings in either a Python or JSON config file."""
    if target.is_symlink():
        raise RuntimeError("Refuse a symlinked configuration target")
    if target.suffix == ".py":
        current = target.read_text() if target.exists() else ""
        addition = "\n# Pinned nbmodel repair policy; restored by patch rollback.\nc = get_config()\n"
        for section, traits in policy.items():
            for name, value in traits.items():
                addition += f"c.{section}.{name} = {value!r}\n"
        result = (current + addition).encode()
        compile(result, str(target), "exec")
        return result
    if target.suffix != ".json":
        raise RuntimeError("Configuration target must be a Python or JSON file")
    current = json.loads(target.read_text()) if target.exists() else {}
    if not isinstance(current, dict):
        raise RuntimeError("Invalid existing Jupyter configuration")
    for section, traits in policy.items():
        previous = current.get(section, {})
        if not isinstance(previous, dict):
            raise RuntimeError("Invalid existing Jupyter trait section")
        current[section] = {**previous, **traits}
    return (json.dumps(current, indent=2) + "\n").encode()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config-file", required=True, type=Path)
    target = parser.parse_args().config_file
    policy = json.loads((Path(__file__).parent / "server-config.json").read_text())
    result = configured_bytes(target, policy)
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=target.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(result.decode())
    temporary.chmod(target.stat().st_mode & 0o777 if target.exists() else 0o644)
    temporary.replace(target)


if __name__ == "__main__":
    main()

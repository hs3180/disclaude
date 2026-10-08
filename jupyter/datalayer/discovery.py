"""Discover target paths using the Jupyter Server interpreter and runtime identity."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import sys


def discover(config_file=None, frontend_dir=None, package_dir=None) -> dict:
    from jupyter_core.paths import jupyter_config_path, jupyter_path, jupyter_runtime_dir
    spec = importlib.util.find_spec("jupyter_server_nbmodel")
    if package_dir is None and (spec is None or spec.origin is None):
        raise RuntimeError("nbmodel is not installed in the selected Python environment")
    package = package_dir or Path(spec.origin).parent
    if frontend_dir:
        frontend = Path(frontend_dir)
    else:
        candidates = [Path(path) / "@datalayer/jupyter-server-nbmodel" for path in jupyter_path("labextensions")]
        candidates = [path for path in candidates if (path / "package.json").is_file()]
        if len(candidates) != 1:
            raise RuntimeError("Exactly one nbmodel Lab bundle is required; select --frontend-dir explicitly")
        frontend = candidates[0]
    config_paths = list(dict.fromkeys(jupyter_config_path()))
    if not config_paths:
        raise RuntimeError("Jupyter configuration search path is empty")
    if config_file:
        config = Path(config_file)
        if not config.is_absolute():
            raise RuntimeError("--config-file must be an absolute target path")
    else:
        candidates = [Path(path) / "jupyter_config.json" for path in config_paths]
        config = next((path for path in candidates if path.exists()), candidates[0])
    if config.is_symlink() or config.suffix not in (".json", ".py"):
        raise RuntimeError("Select a regular Python or JSON Jupyter configuration file")
    return {"python": sys.executable, "prefix": sys.prefix,
            "packageDir": str(Path(package).resolve()), "frontendDir": str(frontend.resolve()),
            "configFile": str(config.absolute()), "configPaths": config_paths,
            "runtimeDir": jupyter_runtime_dir()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config-file", type=Path)
    parser.add_argument("--frontend-dir", type=Path)
    parser.add_argument("--package-dir", type=Path)
    args = parser.parse_args()
    print(json.dumps(discover(args.config_file, args.frontend_dir, args.package_dir)))

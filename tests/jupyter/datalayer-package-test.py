"""Stdlib artifact and file-installation regressions; no Jupyter server required."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import zipfile


SOURCE = Path(__file__).resolve().parents[2] / "jupyter/datalayer"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


deploy = load("patch_deploy", SOURCE / "deploy.py")
sys.path.insert(0, str(SOURCE))
import environment
import discovery
import configure
CLI = SOURCE.parents[1] / "bin/disclaude.js"


def build(target, cli=CLI):
    return json.loads(subprocess.check_output([
        "node", str(cli), "jupyter", "patch", "generate", "--output", str(target)
    ], cwd=target.parent, text=True))


class PackageTests(unittest.TestCase):
    def test_single_file_runs_outside_checkout_and_is_reproducible(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = build(root / "first.pyz")
            second = build(root / "second.pyz")
            self.assertEqual(first["sha256"], second["sha256"])
            output = subprocess.check_output([sys.executable, str(root / "first.pyz"), "info"], cwd=root, text=True)
            self.assertEqual(json.loads(output)["manifestSha256"], deploy.sha(SOURCE / "manifest.json"))
            with zipfile.ZipFile(root / "first.pyz") as archive:
                names = archive.namelist()
                self.assertIn("payload/LICENSE.nbmodel", names)
                self.assertIn("payload/patches/lab-bundle.patch", names)
                self.assertFalse(any("Dockerfile" in name or "compose" in name for name in names))
                self.assertNotIn("payload/reporting-requirements.txt", names)
                self.assertFalse(any(".env" in name or "plan.json" in name or "config-restore" in name for name in names))
            self.assertEqual((root / "first.pyz.sha256").read_text().split()[0], first["sha256"])

    def test_damaged_payload_is_refused_before_installation(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "damaged.pyz"
            build(archive)
            with zipfile.ZipFile(archive) as original:
                files = {name: original.read(name) for name in original.namelist()}
            files["payload/runtime.py"] += b"\n# modified\n"
            with zipfile.ZipFile(archive, "w") as output:
                for name, data in files.items():
                    output.writestr(name, data)
            result = subprocess.run([sys.executable, str(archive), "info"], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("checksum differs", result.stderr)

    def test_undeclared_patch_and_runtime_config_are_not_packaged(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            copied = root / "jupyter/datalayer"
            shutil.copytree(SOURCE, copied, ignore=shutil.ignore_patterns("__pycache__"))
            (copied / "patches/private-debug.patch").write_text("fixture-private-debug")
            (copied / "jupyter-config-restore.json").write_text('{"password":"fixture-secret"}')
            (root / "bin").mkdir()
            for name in ("disclaude.js", "jupyter-patch.js"):
                shutil.copyfile(CLI.parent / name, root / "bin" / name)
            (root / "package.json").write_text('{"type":"module"}')
            build(root / "clean.pyz", root / "bin/disclaude.js")
            with zipfile.ZipFile(root / "clean.pyz") as archive:
                self.assertFalse(any("private-debug" in name or "config-restore" in name for name in archive.namelist()))


    def test_removed_options_are_refused_by_the_generated_artifact(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "repair.pyz"
            build(archive)
            for option in ("--container", "--ssh", "--service", "--system", "--restart", "--stopped"):
                result = subprocess.run([sys.executable, str(archive), "info", option, "fixture"],
                                        capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("unrecognized arguments", result.stderr)


class EnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.package = self.root / "unusual prefix/lib/nbmodel"
        self.frontend = self.root / "separate lab data/extension"
        self.package.mkdir(parents=True)
        self.frontend.mkdir(parents=True)
        self.original = self.package / "source.py"
        self.original.write_text("original = True\n")
        self.original.chmod(0o640)
        self.config = self.root / "custom-config.py"
        self.config.write_text("c = get_config()\nc.ServerApp.port = 9999\n")
        self.state = self.root / "private state"
        self.target = {"python": "/unusual/venv/bin/python", "prefix": "/unusual/venv",
                       "packageDir": str(self.package), "frontendDir": str(self.frontend),
                       "configFile": str(self.config), "configPaths": [str(self.root)],
                       "runtimeDir": str(self.root / "runtime")}
        self.planner = patch.object(environment.install, "plan_files", return_value=(
            [(self.original, b"patched = True\n"), (self.frontend / "new.js", b"patched client\n")], 0))
        self.planner.start()
        self.addCleanup(self.planner.stop)
        self.plan = environment.prepare(SOURCE, deploy.sha(SOURCE / "manifest.json"), self.state, self.target)

    def test_prepare_leaves_installed_files_unchanged(self):
        self.assertEqual(self.original.read_bytes(), b"original = True\n")
        self.assertFalse((self.frontend / "new.js").exists())
        self.assertEqual(self.config.read_text(), "c = get_config()\nc.ServerApp.port = 9999\n")
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)
        status = environment.status(self.plan, self.state)
        self.assertEqual(status["activation"], "not_installed")
        self.assertFalse(status["applicationVerified"])

    def test_apply_and_rollback_preserve_exact_bytes_modes_and_report_restart_required(self):
        applied = environment.transition(self.plan, self.state, "apply")
        self.assertTrue(applied["changed"])
        self.assertEqual(applied["activation"], "server_restart_required")
        self.assertTrue(applied["serverRestartRequired"])
        self.assertFalse(applied["runningCodeVerified"])
        self.assertEqual(self.original.read_bytes(), b"patched = True\n")
        self.assertEqual(self.original.stat().st_mode & 0o777, 0o640)
        self.assertIn("c.ServerApp.port = 9999", self.config.read_text())
        self.assertIn("c.YDocExtension.document_cleanup_delay = None", self.config.read_text())
        self.assertFalse(environment.transition(self.plan, self.state, "apply")["changed"])
        status = environment.status(self.plan, self.state)
        self.assertTrue(status["serverRestartRequired"])
        self.assertFalse(status["applicationVerified"])
        rolled_back = environment.transition(self.plan, self.state, "rollback")
        self.assertTrue(rolled_back["serverRestartRequired"])
        self.assertEqual(self.original.read_bytes(), b"original = True\n")
        self.assertEqual(self.original.stat().st_mode & 0o777, 0o640)
        self.assertFalse((self.frontend / "new.js").exists())
        self.assertFalse((self.package / "disclaude-repair.json").exists())
        self.assertEqual(self.config.read_text(), "c = get_config()\nc.ServerApp.port = 9999\n")
        self.assertFalse(environment.transition(self.plan, self.state, "rollback")["changed"])

    def test_runtime_record_does_not_trigger_server_control_or_hot_reload(self):
        runtime = Path(self.target["runtimeDir"])
        runtime.mkdir()
        (runtime / "jpserver-owned.json").write_text(json.dumps({"pid": 4321}))
        with patch.object(subprocess, "run") as commands:
            result = environment.transition(self.plan, self.state, "apply")
            commands.assert_not_called()
        self.assertTrue(result["serverRestartRequired"])
        self.assertFalse(result["runningCodeVerified"])
        self.assertTrue((runtime / "jpserver-owned.json").exists())

    def test_foreign_edit_and_corrupt_backup_refuse_before_any_target_write(self):
        self.original.write_text("human edit\n")
        with patch.object(environment, "atomic") as writes:
            with self.assertRaisesRegex(environment.EnvironmentError, "outside this deployment"):
                environment.transition(self.plan, self.state, "apply")
            writes.assert_not_called()
        self.original.write_text("original = True\n")
        (self.state / self.plan["files"][0]["original"]).write_text("corrupt backup\n")
        with self.assertRaisesRegex(environment.EnvironmentError, "rollback file changed"):
            environment.transition(self.plan, self.state, "rollback")

    def test_partial_write_failure_keeps_state_for_explicit_rollback(self):
        atomic = environment.atomic
        def fail_second_target(path, *args, **kwargs):
            if path == self.frontend / "new.js":
                raise OSError("injected write failure")
            return atomic(path, *args, **kwargs)
        with patch.object(environment, "atomic", side_effect=fail_second_target):
            with self.assertRaisesRegex(OSError, "injected write failure"):
                environment.transition(self.plan, self.state, "apply")
        self.assertEqual(self.original.read_bytes(), b"patched = True\n")
        self.assertEqual(json.loads((self.state / "plan.json").read_text())["phase"], "apply_requested")
        environment.transition(self.plan, self.state, "rollback")
        self.assertEqual(self.original.read_bytes(), b"original = True\n")
        self.assertFalse((self.frontend / "new.js").exists())

    def test_existing_identical_policy_does_not_prevent_apply_or_idempotence(self):
        config = self.root / "already-configured.json"
        policy = json.loads((SOURCE / "server-config.json").read_text())
        config.write_text(json.dumps(policy, indent=2) + "\n")
        target = {**self.target, "configFile": str(config)}
        state = self.root / "another state"
        plan = environment.prepare(SOURCE, deploy.sha(SOURCE / "manifest.json"), state, target)
        self.assertTrue(environment.transition(plan, state, "apply")["changed"])
        self.assertFalse(environment.transition(plan, state, "apply")["changed"])
        environment.transition(plan, state, "rollback")
        self.assertEqual(json.loads(config.read_text()), policy)

    def test_legacy_managed_state_is_refused_without_writes(self):
        for legacy in ({"deployment": "compose"}, {"service": {"unit": "old.service"}}):
            plan = {**self.plan, **legacy}
            environment.save(self.state, plan)
            with self.assertRaisesRegex(environment.EnvironmentError, "another patch/environment"):
                environment.prepare(SOURCE, deploy.sha(SOURCE / "manifest.json"), self.state, self.target)
            with patch.object(environment, "atomic") as writes:
                with self.assertRaisesRegex(environment.EnvironmentError, "another installation"):
                    environment.transition(plan, self.state, "apply")
                writes.assert_not_called()

    def test_search_paths_and_explicit_selection_do_not_depend_on_prefix_or_home(self):
        paths = types.ModuleType("jupyter_core.paths")
        config_dir = self.root / "custom config dir"
        config_dir.mkdir()
        config = config_dir / "jupyter_config.json"
        config.write_text('{"ServerApp":{"port":9999}}')
        (self.frontend / "package.json").write_text('{}')
        paths.jupyter_config_path = lambda: [str(self.root / "higher priority"), str(config_dir)]
        data = self.root / "custom data/labextensions/@datalayer/jupyter-server-nbmodel"
        data.mkdir(parents=True)
        (data / "package.json").write_text('{}')
        paths.jupyter_path = lambda *args: [str(data.parent.parent)]
        paths.jupyter_runtime_dir = lambda: str(self.root / "runtime")
        spec = types.SimpleNamespace(origin=str(self.package / "__init__.py"))
        with patch.dict(sys.modules, {"jupyter_core": types.ModuleType("jupyter_core"), "jupyter_core.paths": paths}), \
             patch.object(discovery.importlib.util, "find_spec", return_value=spec):
            discovered = discovery.discover()
            self.assertEqual(discovered["configFile"], str(config))
            self.assertEqual(discovered["frontendDir"], str(data.resolve()))
            self.assertEqual(discovery.discover(self.config, self.frontend)["configFile"], str(self.config))
            extra = self.root / "other/labextensions/@datalayer/jupyter-server-nbmodel"
            extra.mkdir(parents=True)
            (extra / "package.json").write_text('{}')
            paths.jupyter_path = lambda *args: [str(data.parent.parent), str(extra.parent.parent)]
            with self.assertRaisesRegex(RuntimeError, "Exactly one"):
                discovery.discover()
            self.assertEqual(discovery.discover(frontend_dir=self.frontend)["frontendDir"], str(self.frontend.resolve()))


if __name__ == "__main__":
    unittest.main()

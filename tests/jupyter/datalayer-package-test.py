"""Stdlib packaging/deployment regressions; no Jupyter server or Docker daemon required."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
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
package = load("patch_package", SOURCE / "package.py")


class PackageTests(unittest.TestCase):
    def test_single_file_runs_outside_checkout_and_is_reproducible(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = package.build(root / "first.pyz")
            second = package.build(root / "second.pyz")
            self.assertEqual(first["sha256"], second["sha256"])
            output = subprocess.check_output([sys.executable, str(root / "first.pyz"), "info"], cwd=root, text=True)
            self.assertEqual(json.loads(output)["manifestSha256"], deploy.sha(SOURCE / "manifest.json"))
            with zipfile.ZipFile(root / "first.pyz") as archive:
                names = archive.namelist()
                self.assertIn("payload/LICENSE.nbmodel", names)
                self.assertIn("payload/patches/lab-bundle.patch", names)
                self.assertFalse(any(".env" in name or "plan.json" in name or "config-restore" in name for name in names))
            self.assertEqual((root / "first.pyz.sha256").read_text().split()[0], first["sha256"])

    def test_damaged_payload_is_refused_before_docker(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "damaged.pyz"
            package.build(archive)
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
            copied = root / "source"
            shutil.copytree(SOURCE, copied, ignore=shutil.ignore_patterns("__pycache__"))
            (copied / "patches/private-debug.patch").write_text("fixture-private-debug")
            (copied / "jupyter-config-restore.json").write_text('{"password":"fixture-secret"}')
            with patch.object(package, "__file__", str(copied / "package.py")):
                package.build(root / "clean.pyz")
            with zipfile.ZipFile(root / "clean.pyz") as archive:
                self.assertFalse(any("private-debug" in name or "config-restore" in name for name in archive.namelist()))


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name)
        self.config = self.state / "original.json"
        self.config.write_text('{"custom":{"keep":true}}\n')
        self.candidate = self.state / "candidate.json"
        self.candidate.write_text('{"custom":{"keep":true},"Extension":{"result_ttl":3600}}\n')
        self.base = self.state / "compose.json"
        self.base.write_text('{"services":{"jupyter":{},"sentinel":{}}}\n')
        self.plan = {"project": "owned-fixture", "service": "jupyter", "directory": str(self.state),
                     "container": "owned-jupyter", "composeFiles": [str(self.base)],
                     "originalImage": "sha256:original", "candidateImage": "sha256:patched",
                     "inputs": {str(self.config): deploy.sha(self.config), str(self.base): deploy.sha(self.base)},
                     "outputs": {}, "phase": "prepared", "manifestSha256": deploy.sha(SOURCE / "manifest.json")}
        self.current = {"image": "sha256:original", "state": {"Status": "running"},
                        "labels": {"com.docker.compose.project": "owned-fixture", "com.docker.compose.service": "jupyter"},
                        "mounts": [{"Destination": deploy.CONFIG_TARGET, "Source": str(self.config)}]}
        for action, image, config in [("apply", "sha256:patched", self.candidate), ("rollback", "sha256:original", self.config)]:
            path = self.state / (action + ".json")
            deploy.write_json(path, deploy.override(self.plan, image, str(config)))
            self.plan[action + "Override"] = str(path)
            self.plan["outputs"][str(path)] = deploy.sha(path)

    def test_explicit_restart_is_required_before_any_service_operation(self):
        with patch.object(deploy, "docker") as docker:
            with self.assertRaisesRegex(deploy.DeploymentError, "--restart"):
                deploy.transition(self.plan, self.state, "apply", False)
            docker.assert_not_called()

    def test_original_config_drift_refuses_transition(self):
        self.config.write_text('{"human":"new setting"}\n')
        with patch.object(deploy, "docker") as docker:
            with self.assertRaisesRegex(deploy.DeploymentError, "input changed"):
                deploy.transition(self.plan, self.state, "apply", True)
            docker.assert_not_called()

    def test_prepared_config_drift_refuses_transition(self):
        path = Path(self.plan["applyOverride"])
        path.write_text('{}\n')
        with patch.object(deploy, "docker") as docker:
            with self.assertRaisesRegex(deploy.DeploymentError, "file changed"):
                deploy.transition(self.plan, self.state, "apply", True)
            docker.assert_not_called()

    def test_resolved_environment_drift_is_refused_without_exposing_values(self):
        self.plan["composeConfigSha256"] = "the-original-resolved-config"
        with patch.object(deploy, "docker", return_value='{"environment":{"value":"fixture-secret"}}') as docker:
            with self.assertRaisesRegex(deploy.DeploymentError, "interpolation") as caught:
                deploy.transition(self.plan, self.state, "apply", True)
            self.assertNotIn("fixture-secret", str(caught.exception))
            self.assertEqual(docker.call_count, 1)

    def test_foreign_image_is_refused(self):
        self.current["image"] = "sha256:foreign"
        with patch.object(deploy, "inspect_container", return_value=self.current), patch.object(deploy, "docker") as docker:
            with self.assertRaisesRegex(deploy.DeploymentError, "outside this deployment"):
                deploy.transition(self.plan, self.state, "apply", True)
            docker.assert_not_called()

    def test_writable_layer_and_file_only_database_mount_are_refused(self):
        config = {"BaseFileIdManager": {"db_path": "/ids/file_id_manager.db"}}
        container = {"mounts": []}
        with self.assertRaisesRegex(deploy.DeploymentError, "persistent directory"):
            deploy.check_file_ids(config, container)
        container["mounts"] = [{"Type": "bind", "Source": "/owned/db", "Destination": "/ids/file_id_manager.db", "RW": True}]
        with self.assertRaises(deploy.DeploymentError):
            deploy.check_file_ids(config, container)
        container["mounts"][0]["Destination"] = "/ids"
        deploy.check_file_ids(config, container)

    def test_changed_data_mount_refuses_transition(self):
        self.current["mounts"].append({"Type": "bind", "Source": "/old-data", "Destination": "/notebooks", "RW": True})
        self.plan["originalMounts"] = deploy.stable_mounts(self.current)
        self.current["mounts"][-1]["Source"] = "/new-data"
        with patch.object(deploy, "inspect_container", return_value=self.current), patch.object(deploy, "docker") as docker:
            with self.assertRaisesRegex(deploy.DeploymentError, "data mounts changed"):
                deploy.transition(self.plan, self.state, "apply", True)
            docker.assert_not_called()

    def test_repeated_apply_does_not_recreate_a_running_candidate(self):
        self.current["image"] = "sha256:patched"
        self.current["mounts"][0]["Source"] = str(self.candidate)
        with patch.object(deploy, "inspect_container", return_value=self.current), patch.object(deploy, "docker") as docker:
            result = deploy.transition(self.plan, self.state, "apply", True)
            self.assertFalse(result["changed"])
            docker.assert_not_called()

    def test_unknown_up_result_retains_rollback_and_does_not_replay(self):
        with patch.object(deploy, "inspect_container", return_value=self.current), patch.object(deploy, "check_compose_merge"), \
             patch.object(deploy, "docker", side_effect=deploy.DeploymentError("lost reply")) as docker:
            with self.assertRaisesRegex(deploy.DeploymentError, "lost reply"):
                deploy.transition(self.plan, self.state, "apply", True)
            self.assertEqual(docker.call_count, 1)
        saved = json.loads((self.state / "plan.json").read_text())
        self.assertEqual(saved["phase"], "apply_requested")
        self.assertEqual(saved["originalImage"], "sha256:original")
        self.assertTrue(Path(saved["rollbackOverride"]).is_file())

    def test_override_must_preserve_other_services_and_notebook_mount(self):
        baseline = {"services": {"jupyter": {"image": "original", "environment": {"keep": "fixture"},
                                             "volumes": [{"target": "/notebooks", "source": "/owned-data"},
                                                         {"target": deploy.CONFIG_TARGET, "source": "/old"}]},
                                 "sentinel": {"image": "original"}}}
        candidate = json.loads(json.dumps(baseline))
        candidate["services"]["jupyter"]["image"] = "patched"
        candidate["services"]["jupyter"]["volumes"][1]["source"] = "/new"
        with patch.object(deploy, "docker", side_effect=[json.dumps(baseline), json.dumps(candidate)]):
            deploy.check_compose_merge(self.plan, self.plan["applyOverride"])
        candidate["services"]["sentinel"]["image"] = "unexpected"
        with patch.object(deploy, "docker", side_effect=[json.dumps(baseline), json.dumps(candidate)]):
            with self.assertRaisesRegex(deploy.DeploymentError, "other than"):
                deploy.check_compose_merge(self.plan, self.plan["applyOverride"])

    def test_existing_plan_is_reused_without_replacing_rollback(self):
        deploy.write_json(self.state / "plan.json", self.plan)
        with patch.object(deploy, "inspect_container", return_value=self.current), patch.object(deploy, "docker") as docker:
            result = deploy.prepare(SOURCE, self.plan["manifestSha256"], self.plan["container"], self.state)
        self.assertEqual(result["originalImage"], "sha256:original")
        docker.assert_not_called()


if __name__ == "__main__":
    unittest.main()

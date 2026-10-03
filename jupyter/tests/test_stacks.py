from types import SimpleNamespace
from pathlib import Path
import tomllib
import unittest
from unittest.mock import patch

from disclaude_jupyter.extension import NotebookExtension
from disclaude_jupyter.stacks import STACK_PROFILES, verify_stack


class StackTests(unittest.TestCase):
    def test_dependency_extras_match_each_exact_runtime_profile(self):
        metadata = tomllib.loads((Path(__file__).parents[1] / "pyproject.toml").read_text())
        extras = metadata["project"]["optional-dependencies"]
        for profile, versions in STACK_PROFILES.items():
            self.assertEqual(dict(item.split("==", 1) for item in extras[profile]), versions)

    def test_default_profile_has_no_experimental_opt_in(self):
        app = NotebookExtension()
        self.assertEqual(app.stack_profile, "managed")
        self.assertFalse(app.allow_experimental_stack)

    def test_managed_requires_its_exact_full_profile(self):
        verify_stack("managed", dict(STACK_PROFILES["managed"]))

    def test_configured_profile_is_rejected_without_explicit_opt_in(self):
        with self.assertRaisesRegex(RuntimeError, "experimental"):
            verify_stack("configured-20261003", dict(STACK_PROFILES["configured-20261003"]))

    def test_configured_profile_accepts_only_its_exact_versions_when_opted_in(self):
        verify_stack("configured-20261003", dict(STACK_PROFILES["configured-20261003"]),
                     allow_experimental=True)

    def test_opt_in_does_not_select_a_different_profile(self):
        with self.assertRaisesRegex(RuntimeError, "exact stack"):
            verify_stack("managed", dict(STACK_PROFILES["configured-20261003"]),
                         allow_experimental=True)

    def test_drift_in_each_dependency_is_rejected(self):
        for profile, versions in STACK_PROFILES.items():
            for package in versions:
                with self.subTest(profile=profile, package=package):
                    actual = dict(versions, **{package: "unverified"})
                    with self.assertRaisesRegex(RuntimeError, "exact stack"):
                        verify_stack(profile, actual, allow_experimental=True)

    def test_missing_or_extra_dependency_is_rejected(self):
        for profile, versions in STACK_PROFILES.items():
            missing = dict(versions)
            missing.pop("pycrdt")
            for actual in [missing, dict(versions, unknown="1")]:
                with self.assertRaisesRegex(RuntimeError, "exact stack"):
                    verify_stack(profile, actual, allow_experimental=True)

    def test_unknown_profile_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "unknown"):
            verify_stack("future", {}, allow_experimental=True)

    def app(self, *, allow=False, original=False):
        return SimpleNamespace(
            stack_profile="configured-20261003", allow_experimental_stack=allow,
            serverapp=SimpleNamespace(extension_manager=SimpleNamespace(
                extensions={"jupyter_server_nbmodel": SimpleNamespace(enabled=original)})),
            handlers=[],
        )

    def test_handler_registration_is_fenced_before_any_route_is_changed(self):
        app = self.app()
        with patch("disclaude_jupyter.extension.version",
                   side_effect=STACK_PROFILES["configured-20261003"].__getitem__):
            with self.assertRaisesRegex(RuntimeError, "experimental"):
                NotebookExtension.initialize_handlers(app)
        self.assertEqual(app.handlers, [])

    def test_opt_in_still_refuses_competing_original_execution_routes(self):
        app = self.app(allow=True, original=True)
        with patch("disclaude_jupyter.extension.version",
                   side_effect=STACK_PROFILES["configured-20261003"].__getitem__):
            with self.assertRaisesRegex(RuntimeError, "original nbmodel"):
                NotebookExtension.initialize_handlers(app)
        self.assertEqual(app.handlers, [])

    def test_configured_registration_preserves_common_handlers(self):
        app = self.app(allow=True)
        with patch("disclaude_jupyter.extension.version",
                   side_effect=STACK_PROFILES["configured-20261003"].__getitem__):
            NotebookExtension.initialize_handlers(app)
        self.assertEqual(len(app.handlers), 7)
        self.assertEqual(app.stack, STACK_PROFILES["configured-20261003"])
        self.assertIsNone(app._components)


if __name__ == "__main__":
    unittest.main()

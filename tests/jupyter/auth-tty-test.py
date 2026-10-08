"""Real PTY checks for secret echo, JSON stdout and terminal restoration; no Jupyter."""
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import tempfile
import termios
import time
import unittest

AUTH = (Path(__file__).resolve().parents[2] / "bin/jupyter-auth.js").as_uri()
NODE = os.environ.get("JUPYTER_AUTH_TEST_NODE", "node")
BASE = "https://jupyter.invalid/proxy/user/"


class PromptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="jupyter-auth-tty-")
        self.master, self.slave = pty.openpty()
        self.original = termios.tcgetattr(self.slave)
        self.output = b""
        self.child = None

    def tearDown(self):
        if self.child:
            if self.child.poll() is None:
                self.child.kill()
            self.child.communicate(timeout=5)
        os.close(self.master)
        os.close(self.slave)
        self.temp.cleanup()

    def start(self, secret, options=None, environment=None):
        digest = hashlib.sha256(secret.encode()).hexdigest()
        program = f"""
import {{ createHash }} from 'node:crypto';
import {{ resolveJupyterAuth }} from {json.dumps(AUTH)};
try {{
  const auth = await resolveJupyterAuth({json.dumps(options or {'jupyter': 'configured'})});
  if (createHash('sha256').update(auth.secret).digest('hex') !== '{digest}') throw new Error('Input differs');
  console.log(JSON.stringify({{ok:true, mode:auth.mode, baseUrl:auth.baseUrl}}));
}} catch (error) {{ console.error(error.message); process.exitCode = 1; }}
"""
        env = {k: v for k, v in os.environ.items() if not k.startswith("JUPYTERLAB_")}
        env.update(environment or {})
        self.child = subprocess.Popen(
            [NODE, "--input-type=module", "-e", program],
            cwd=self.temp.name, env=env, stdin=self.slave,
            stdout=subprocess.PIPE, stderr=self.slave,
        )

    def wait_prompt(self, label):
        deadline = time.monotonic() + 10
        while label.encode() not in self.output:
            if time.monotonic() >= deadline:
                self.fail("Expected prompt did not arrive")
            if select.select([self.master], [], [], 0.1)[0]:
                self.output += os.read(self.master, 8192)
            elif self.child.poll() is not None:
                self.fail("Prompt process exited early")
        self.assertFalse(termios.tcgetattr(self.slave)[3] & termios.ECHO)

    def send(self, value):
        os.write(self.master, value.encode())

    def finish(self, code, secret):
        stdout, _ = self.child.communicate(timeout=10)
        while select.select([self.master], [], [], 0)[0]:
            self.output += os.read(self.master, 8192)
        self.assertEqual(self.child.returncode, code)
        self.assertNotIn(secret.encode(), self.output)
        self.assertNotIn(secret.encode(), stdout)
        self.assertEqual(termios.tcgetattr(self.slave), self.original)
        return json.loads(stdout) if stdout else None

    def test_password_url_and_unicode_input_preserve_json_stdout_and_echo(self):
        secret = "fixture-密码-'$`#"
        self.start(secret)
        self.wait_prompt("Jupyter URL (without credentials): ")
        self.send(BASE + "\r")
        self.wait_prompt("Authentication [password/token] (password): ")
        self.send("\r")
        self.wait_prompt("Jupyter password (hidden): ")
        self.send(secret + "x\x7f\r")
        self.assertEqual(self.finish(0, secret), {"ok": True, "mode": "password", "baseUrl": BASE})

    def test_forced_token_overrides_environment_without_echo(self):
        secret = "fixture-fresh-token"
        self.start(secret, {"jupyter": "configured", "interactive": True},
                   {"JUPYTERLAB_HOST": BASE, "JUPYTERLAB_PASS": "fixture-configured-password"})
        self.wait_prompt("Authentication [password/token] (password): ")
        self.send("token\r")
        self.wait_prompt("Jupyter API token (hidden): ")
        self.send("discard\x15" + secret + "\r")
        self.assertEqual(self.finish(0, secret), {"ok": True, "mode": "token", "baseUrl": BASE})
        self.assertNotIn(b"discard", self.output)
        self.assertNotIn(b"fixture-configured-password", self.output)

    def test_ctrl_c_and_ctrl_d_cancel_and_restore_echo(self):
        for cancel in ("\x03", "\x04"):
            with self.subTest(cancel=repr(cancel)):
                self.output = b""
                secret = "fixture-cancelled-password"
                self.start(secret, {"jupyter": BASE, "passwordEnv": "JUPYTERLAB_PASS"})
                self.wait_prompt("Jupyter password (hidden): ")
                self.send(secret + cancel)
                self.assertIsNone(self.finish(1, secret))
                self.assertIn(b"input cancelled", self.output)

    def test_sigterm_cancels_and_restores_echo(self):
        secret = "fixture-terminated-password"
        self.start(secret, {"jupyter": BASE, "passwordEnv": "JUPYTERLAB_PASS"})
        self.wait_prompt("Jupyter password (hidden): ")
        self.send(secret)
        self.child.terminate()
        self.assertIsNone(self.finish(1, secret))
        self.assertIn(b"input cancelled", self.output)


if __name__ == "__main__":
    unittest.main()

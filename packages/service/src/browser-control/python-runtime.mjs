import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Keep service startup and browser-coordination CI on the same tested runtime. */
export const BROWSER_PYTHON_REQUIREMENTS = Object.freeze({
  'browser-use': '0.13.10',
  'browser-harness': '0.1.13',
});

const runtimeProbe = String.raw`
import importlib.metadata as metadata
import importlib.util
import json
import subprocess
import sys

packages = {}
for name in ('browser-use', 'browser-harness'):
    try:
        packages[name] = metadata.version(name)
    except metadata.PackageNotFoundError:
        packages[name] = None

def has_module(name):
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ModuleNotFoundError, ValueError):
        return False

modules = {
    'browser_use.cli': has_module('browser_use.cli'),
    'browser_harness.daemon': has_module('browser_harness.daemon'),
}
try:
    checked = subprocess.run(
        [sys.executable, '-m', 'pip', 'check'],
        capture_output=True,
        text=True,
        timeout=6,
        check=False,
    )
    dependency_check = checked.returncode == 0
    dependency_problems = [
        line.strip()[:240]
        for line in (checked.stdout + '\n' + checked.stderr).splitlines()
        if line.strip()
    ][:4]
    if checked.returncode and not dependency_problems:
        dependency_problems = [f'pip check exited with status {checked.returncode}']
except Exception as error:
    dependency_check = False
    dependency_problems = [f'pip check unavailable ({type(error).__name__})']

print(json.dumps({
    'executable': sys.executable,
    'pythonVersion': list(sys.version_info[:3]),
    'packages': packages,
    'modules': modules,
    'dependencyCheck': dependency_check,
    'dependencyProblems': dependency_problems,
}))
`;

const pythonVersionProbe = String.raw`
import json
import sys
print(json.dumps({'pythonVersion': list(sys.version_info[:3])}))
`;

const inheritedPythonEnvironment = [
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONUSERBASE',
  'PYTHONSTARTUP',
  'PYTHONINSPECT',
  'PYTHONEXECUTABLE',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
  'CONDA_DEFAULT_ENV',
  'CONDA_PROMPT_MODIFIER',
  'CONDA_SHLVL',
];

/** Prevent a caller's active Python/Conda environment from contaminating the venv. */
export function createBrowserPythonEnvironment(env = process.env) {
  const childEnvironment = {
    ...process.env,
    ...env,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
  };
  for (const name of inheritedPythonEnvironment) delete childEnvironment[name];
  return childEnvironment;
}

function runtimeDirectory(env) {
  const home = typeof env.HOME === 'string' && isAbsolute(env.HOME) ? env.HOME : homedir();
  const dataHome =
    typeof env.XDG_DATA_HOME === 'string' && isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : join(home, '.local', 'share');
  return join(dataHome, 'disclaude', 'browser-harness-runtime');
}

function runtimeExecutable(directory) {
  return join(
    directory,
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python3'
  );
}

function pythonCandidates(env, managedExecutable) {
  const candidates = [];
  const seen = new Set();
  const proposed = [managedExecutable];
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    // Do not let a relative PATH component make service startup depend on cwd.
    if (!entry || !isAbsolute(entry)) continue;
    proposed.push(resolve(entry, process.platform === 'win32' ? 'python3.exe' : 'python3'));
  }
  for (const path of proposed) {
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      accessSync(path, constants.X_OK);
      // Preserve the venv path even when python3 is a symlink to a base Python;
      // executing its realpath would bypass the venv's site-packages.
      candidates.push(path);
    } catch {
      // A missing/non-executable managed runtime or PATH entry is not a candidate.
    }
  }
  return candidates;
}

function parseProbe(executable, env, execFileSyncImpl) {
  const output = execFileSyncImpl(executable, ['-c', runtimeProbe], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 64 * 1024,
    env: createBrowserPythonEnvironment(env),
  });
  return JSON.parse(String(output).trim().split(/\r?\n/u).at(-1));
}

function compatible(report) {
  if (!report || typeof report !== 'object') return false;
  const version = report.pythonVersion;
  if (!Array.isArray(version) || version[0] < 3 || (version[0] === 3 && version[1] < 11))
    return false;
  if (
    Object.entries(BROWSER_PYTHON_REQUIREMENTS).some(
      ([name, wanted]) => report.packages?.[name] !== wanted
    )
  )
    return false;
  return (
    report.modules?.['browser_use.cli'] === true &&
    report.modules?.['browser_harness.daemon'] === true &&
    report.dependencyCheck === true
  );
}

function describe(candidate, report) {
  if (!report || typeof report !== 'object') return `${candidate} (runtime probe failed)`;
  const version = Array.isArray(report.pythonVersion)
    ? report.pythonVersion.join('.')
    : 'unknown Python version';
  const packages = Object.entries(BROWSER_PYTHON_REQUIREMENTS)
    .map(([name]) => `${name}=${report.packages?.[name] ?? 'missing'}`)
    .join(', ');
  const missingModules = Object.entries(report.modules ?? {})
    .filter(([, present]) => !present)
    .map(([name]) => name);
  const dependencyProblems =
    report.dependencyCheck === true
      ? []
      : report.dependencyProblems?.length
        ? report.dependencyProblems
        : ['pip check failed'];
  const details = [
    missingModules.length ? `missing ${missingModules.join(', ')}` : '',
    dependencyProblems.length ? `dependency conflicts: ${dependencyProblems.join('; ')}` : '',
  ].filter(Boolean);
  return `${candidate} (Python ${version}; ${packages}${details.length ? `; ${details.join('; ')}` : ''})`;
}

function selectedRuntime(executable, report, managedExecutable) {
  return {
    executable,
    pythonVersion: report.pythonVersion.join('.'),
    packages: { ...report.packages },
    dependencyCheck: true,
    managed: executable === managedExecutable,
  };
}

/**
 * Prefer Disclaude's isolated runtime, then accept only fully consistent PATH
 * candidates. PATH order is not trusted: launchd may put an unrelated Python first.
 */
export function resolveBrowserPython(env = process.env, { execFileSyncImpl = execFileSync } = {}) {
  const managedExecutable = runtimeExecutable(runtimeDirectory(env));
  const candidates = pythonCandidates(env, managedExecutable);
  const checked = [];
  for (const candidate of candidates) {
    let report;
    try {
      report = parseProbe(candidate, env, execFileSyncImpl);
    } catch {
      checked.push(`${candidate} (runtime probe failed)`);
      continue;
    }
    checked.push(describe(candidate, report));
    if (compatible(report)) return selectedRuntime(candidate, report, managedExecutable);
  }

  const required = Object.entries(BROWSER_PYTHON_REQUIREMENTS)
    .map(([name, version]) => `${name}==${version}`)
    .join(' and ');
  const searched = checked.length
    ? checked.join('; ')
    : 'no absolute python3 executable was found on PATH';
  throw new Error(
    `No compatible browser harness runtime is available to the Disclaude service. ` +
      `Required: Python >=3.11 with ${required} and consistent dependencies (pip check). ` +
      `Install the isolated runtime with "disclaude browser runtime install". Checked: ${searched}`
  );
}

function pythonVersion(executable, env, execFileSyncImpl) {
  const output = execFileSyncImpl(executable, ['-c', pythonVersionProbe], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 16 * 1024,
    env: createBrowserPythonEnvironment(env),
  });
  const report = JSON.parse(String(output).trim().split(/\r?\n/u).at(-1));
  const version = report.pythonVersion;
  if (!Array.isArray(version) || version[0] < 3 || (version[0] === 3 && version[1] < 11))
    throw new Error('unsupported Python version');
  return version.join('.');
}

function runInstallCommand(executable, args, env, timeout, execFileSyncImpl, stage) {
  try {
    execFileSyncImpl(executable, args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 1024 * 1024,
      stdio: 'ignore',
      env: {
        ...createBrowserPythonEnvironment(env),
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
      },
    });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? ` (exit ${error.status})` : '';
    throw new Error(
      `Unable to ${stage}${status}; command output was suppressed to protect configured credentials`
    );
  }
}

/** Create (or verify) an app-owned venv without changing a shared Python install. */
export function installBrowserPythonRuntime(
  env = process.env,
  { execFileSyncImpl = execFileSync } = {}
) {
  const directory = runtimeDirectory(env);
  const managedExecutable = runtimeExecutable(directory);
  const parent = dirname(directory);
  mkdirSync(parent, { recursive: true, mode: 0o700 });

  const lockPath = `${directory}.install.lock`;
  let lock;
  try {
    lock = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw new Error('Browser harness runtime installation is already in progress');
    throw new Error('Unable to create the private browser runtime installation lock');
  }

  try {
    if (existsSync(directory)) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`Refusing to replace non-directory managed runtime at ${directory}`);
      let report;
      try {
        report = parseProbe(managedExecutable, env, execFileSyncImpl);
      } catch {
        throw new Error(
          `Managed browser runtime at ${directory} is incomplete or unreadable; it was preserved`
        );
      }
      if (!compatible(report))
        throw new Error(
          `Managed browser runtime at ${directory} is incompatible: ${describe(managedExecutable, report)}; it was preserved`
        );
      return selectedRuntime(managedExecutable, report, managedExecutable);
    }

    const candidates = pythonCandidates(env, managedExecutable).filter(
      (path) => path !== managedExecutable
    );
    let bootstrap;
    const checked = [];
    for (const candidate of candidates) {
      try {
        const version = pythonVersion(candidate, env, execFileSyncImpl);
        bootstrap = { executable: candidate, version };
        break;
      } catch {
        checked.push(candidate);
      }
    }
    if (!bootstrap) {
      const searched = checked.length
        ? checked.join(', ')
        : 'no absolute python3 executable was found on PATH';
      throw new Error(
        `Cannot install browser runtime: Python >=3.11 is required. Checked: ${searched}`
      );
    }

    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
    runInstallCommand(
      bootstrap.executable,
      ['-m', 'venv', directory],
      env,
      120000,
      execFileSyncImpl,
      `create the managed Python environment with Python ${bootstrap.version}`
    );
    accessSync(managedExecutable, constants.X_OK);
    const requirements = Object.entries(BROWSER_PYTHON_REQUIREMENTS).map(
      ([name, version]) => `${name}==${version}`
    );
    runInstallCommand(
      managedExecutable,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...requirements],
      env,
      300000,
      execFileSyncImpl,
      'install pinned browser harness packages'
    );

    let report;
    try {
      report = parseProbe(managedExecutable, env, execFileSyncImpl);
    } catch {
      throw new Error(
        `Managed browser runtime at ${directory} failed its validation probe and was preserved`
      );
    }
    if (!compatible(report))
      throw new Error(
        `Managed browser runtime at ${directory} failed validation: ${describe(managedExecutable, report)}; it was preserved`
      );
    return selectedRuntime(managedExecutable, report, managedExecutable);
  } finally {
    closeSync(lock);
    try {
      unlinkSync(lockPath);
    } catch {
      /* Preserve the original operation result. */
    }
  }
}

import { accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/** Keep service startup and browser-coordination CI on the same tested runtime. */
export const BROWSER_PYTHON_REQUIREMENTS = Object.freeze({
  'browser-use': '0.13.10',
  'browser-harness': '0.1.13',
});

const probe = String.raw`
import importlib.metadata as metadata
import importlib.util
import json
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
print(json.dumps({
    'executable': sys.executable,
    'pythonVersion': list(sys.version_info[:3]),
    'packages': packages,
    'modules': modules,
}))
`;

function pythonCandidates(env) {
  const candidates = [];
  const seen = new Set();
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    // Do not let a relative PATH component make service startup depend on cwd.
    if (!entry || !isAbsolute(entry)) continue;
    const path = resolve(entry, process.platform === 'win32' ? 'python3.exe' : 'python3');
    try {
      accessSync(path, constants.X_OK);
      // Preserve the venv path even when python3 is a symlink to a base Python;
      // executing its realpath would bypass the venv's site-packages.
      if (!seen.has(path)) {
        seen.add(path);
        candidates.push(path);
      }
    } catch {
      // A PATH entry without an executable python3 is not a candidate.
    }
  }
  return candidates;
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
    report.modules?.['browser_harness.daemon'] === true
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
  return `${candidate} (Python ${version}; ${packages}${missingModules.length ? `; missing ${missingModules.join(', ')}` : ''})`;
}

/**
 * Select one pinned browser-harness runtime from the service PATH.
 * PATH order is not trusted: launchd may put an unrelated system Python first.
 */
export function resolveBrowserPython(env = process.env, { execFileSyncImpl = execFileSync } = {}) {
  const candidates = pythonCandidates(env);
  const checked = [];
  for (const candidate of candidates) {
    let report;
    try {
      const output = execFileSyncImpl(candidate, ['-c', probe], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 64 * 1024,
        env: { ...process.env, ...env, PYTHONDONTWRITEBYTECODE: '1' },
      });
      report = JSON.parse(String(output).trim().split(/\r?\n/u).at(-1));
    } catch {
      checked.push(`${candidate} (runtime probe failed)`);
      continue;
    }
    checked.push(describe(candidate, report));
    if (compatible(report)) {
      return {
        executable: candidate,
        pythonVersion: report.pythonVersion.join('.'),
        packages: { ...report.packages },
      };
    }
  }

  const required = Object.entries(BROWSER_PYTHON_REQUIREMENTS)
    .map(([name, version]) => `${name}==${version}`)
    .join(' and ');
  const searched = checked.length
    ? checked.join('; ')
    : 'no absolute python3 executable was found on PATH';
  throw new Error(
    `No compatible browser harness runtime on the Disclaude service PATH. ` +
      `Required: Python >=3.11 with ${required}. Checked: ${searched}`
  );
}

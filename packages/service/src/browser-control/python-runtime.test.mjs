import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BROWSER_PYTHON_REQUIREMENTS, resolveBrowserPython } from './python-runtime.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakePython(directory, value) {
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, 'python3');
  writeFileSync(
    executable,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(value))} + "\\n");\n`,
    { mode: 0o700 }
  );
  chmodSync(executable, 0o700);
  return executable;
}

function runtimeReport({
  pythonVersion = [3, 12, 7],
  packages = BROWSER_PYTHON_REQUIREMENTS,
  modules,
} = {}) {
  return {
    executable: '/fixture/python3',
    pythonVersion,
    packages: { ...packages },
    modules: modules ?? { 'browser_use.cli': true, 'browser_harness.daemon': true },
  };
}

describe('browser harness Python runtime selection', () => {
  it('skips an incompatible first python3 and selects the later pinned runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-python-runtime-'));
    roots.push(root);
    const incompatible = fakePython(
      join(root, 'system'),
      runtimeReport({ packages: { 'browser-use': null, 'browser-harness': null } })
    );
    const compatible = fakePython(join(root, 'managed'), runtimeReport());
    const env = {
      ...process.env,
      PATH: [join(root, 'system'), join(root, 'managed')].join(delimiter),
    };

    expect(resolveBrowserPython(env)).toEqual({
      executable: compatible,
      pythonVersion: '3.12.7',
      packages: { ...BROWSER_PYTHON_REQUIREMENTS },
    });
    expect(incompatible).not.toBe(compatible);
  });

  it('preserves a virtual-environment python symlink instead of resolving to its base interpreter', () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-python-runtime-'));
    roots.push(root);
    const base = fakePython(join(root, 'base'), runtimeReport());
    const virtualenv = join(root, 'venv', process.platform === 'win32' ? 'python3.exe' : 'python3');
    mkdirSync(join(root, 'venv'), { recursive: true });
    symlinkSync(base, virtualenv);
    const env = { ...process.env, PATH: join(root, 'venv') };

    expect(resolveBrowserPython(env).executable).toBe(virtualenv);
  });

  it('rejects unsupported Python and package version drift with actionable diagnostics', () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-python-runtime-'));
    roots.push(root);
    fakePython(join(root, 'old-python'), runtimeReport({ pythonVersion: [3, 10, 14] }));
    fakePython(
      join(root, 'wrong-packages'),
      runtimeReport({ packages: { 'browser-use': '0.13.9', 'browser-harness': '0.1.13' } })
    );
    const env = {
      ...process.env,
      PATH: [join(root, 'old-python'), join(root, 'wrong-packages')].join(delimiter),
    };

    expect(() => resolveBrowserPython(env)).toThrow(/Python >=3\.11/u);
    expect(() => resolveBrowserPython(env)).toThrow(/browser-use=0\.13\.9/u);
  });

  it('rejects a candidate missing a worker module and ignores relative PATH entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-python-runtime-'));
    roots.push(root);
    fakePython(
      join(root, 'incomplete'),
      runtimeReport({ modules: { 'browser_use.cli': true, 'browser_harness.daemon': false } })
    );
    const env = { ...process.env, PATH: ['.', join(root, 'incomplete')].join(delimiter) };

    expect(() => resolveBrowserPython(env)).toThrow(/missing browser_harness\.daemon/u);
    expect(() => resolveBrowserPython({ ...env, PATH: '.' })).toThrow(
      /no absolute python3 executable/u
    );
  });
});

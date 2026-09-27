import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BROWSER_PYTHON_REQUIREMENTS,
  createBrowserPythonEnvironment,
  installBrowserPythonRuntime,
  resolveBrowserPython,
} from './python-runtime.mjs';

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
  dependencyCheck = true,
  dependencyProblems = [],
} = {}) {
  return {
    executable: '/fixture/python3',
    pythonVersion,
    packages: { ...packages },
    modules: modules ?? { 'browser_use.cli': true, 'browser_harness.daemon': true },
    dependencyCheck,
    dependencyProblems,
  };
}

describe('browser harness Python runtime selection', () => {
  it('removes inherited Python and Conda environment overrides', () => {
    const env = createBrowserPythonEnvironment({
      ...process.env,
      PYTHONHOME: '/fixture/python-home',
      PYTHONPATH: '/fixture/python-path',
      PYTHONUSERBASE: '/fixture/user-base',
      VIRTUAL_ENV: '/fixture/other-venv',
      CONDA_PREFIX: '/fixture/conda',
    });

    expect(env).toMatchObject({ PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' });
    for (const name of ['PYTHONHOME', 'PYTHONPATH', 'PYTHONUSERBASE', 'VIRTUAL_ENV', 'CONDA_PREFIX'])
      expect(env[name]).toBeUndefined();
  });

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
      dependencyCheck: true,
      managed: false,
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

  it('prefers the private managed runtime over a compatible shared PATH runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-python-runtime-'));
    roots.push(root);
    const shared = fakePython(join(root, 'shared'), runtimeReport());
    const managed = fakePython(
      join(root, 'data', 'disclaude', 'browser-harness-runtime', 'bin'),
      runtimeReport()
    );
    const env = {
      ...process.env,
      HOME: root,
      XDG_DATA_HOME: join(root, 'data'),
      PATH: join(root, 'shared'),
    };

    expect(resolveBrowserPython(env)).toMatchObject({
      executable: managed,
      managed: true,
      dependencyCheck: true,
    });
    expect(shared).not.toBe(managed);
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

  it('rejects a candidate missing a harness module and ignores relative PATH entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-python-runtime-'));
    roots.push(root);
    fakePython(
      join(root, 'incomplete'),
      runtimeReport({ modules: { 'browser_use.cli': true, 'browser_harness.daemon': false } })
    );
    const env = { ...process.env, PATH: ['.', join(root, 'incomplete')].join(delimiter) };

    expect(() => resolveBrowserPython(env)).toThrow(/missing browser_harness\.daemon/u);
    expect(() => resolveBrowserPython({ ...env, PATH: '.' })).toThrow(
      /disclaude browser runtime install/u
    );
  });

  it('rejects transitive dependency conflicts with pip-check diagnostics', () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-python-runtime-'));
    roots.push(root);
    fakePython(
      join(root, 'conflicting'),
      runtimeReport({
        dependencyCheck: false,
        dependencyProblems: ['browser-use requires openai==2.26.0, but have 2.41.1'],
      })
    );
    const env = { ...process.env, PATH: join(root, 'conflicting') };

    expect(() => resolveBrowserPython(env)).toThrow(/openai==2\.26\.0/u);
    expect(() => resolveBrowserPython(env)).toThrow(/disclaude browser runtime install/u);
  });

  it('installs a private venv once and validates it before reporting success', () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-python-runtime-'));
    roots.push(root);
    const bootstrap = fakePython(join(root, 'bootstrap'), runtimeReport());
    const env = {
      ...process.env,
      HOME: root,
      XDG_DATA_HOME: join(root, 'data'),
      PATH: join(root, 'bootstrap'),
    };
    let venvCreations = 0;
    let packageInstalls = 0;
    const execFileSyncImpl = (_executable, args) => {
      if (args[0] === '-m' && args[1] === 'venv') {
        venvCreations += 1;
        fakePython(join(args[2], 'bin'), runtimeReport());
        return '';
      }
      if (args[0] === '-m' && args[1] === 'pip') {
        packageInstalls += 1;
        return '';
      }
      return `${JSON.stringify(runtimeReport())}\n`;
    };

    const installed = installBrowserPythonRuntime(env, { execFileSyncImpl });
    expect(installed).toMatchObject({
      executable: join(root, 'data', 'disclaude', 'browser-harness-runtime', 'bin', 'python3'),
      pythonVersion: '3.12.7',
      dependencyCheck: true,
      managed: true,
    });
    expect(venvCreations).toBe(1);
    expect(packageInstalls).toBe(1);
    expect(installBrowserPythonRuntime(env, { execFileSyncImpl })).toEqual(installed);
    expect(venvCreations).toBe(1);
    expect(packageInstalls).toBe(1);
    expect(existsSync(bootstrap)).toBe(true);
  });

  it('preserves an existing managed runtime that fails dependency validation', () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-python-runtime-'));
    roots.push(root);
    const executable = fakePython(
      join(root, 'data', 'disclaude', 'browser-harness-runtime', 'bin'),
      runtimeReport({ dependencyCheck: false, dependencyProblems: ['pydantic version conflict'] })
    );
    const env = { ...process.env, HOME: root, XDG_DATA_HOME: join(root, 'data') };

    expect(() => installBrowserPythonRuntime(env)).toThrow(/pydantic version conflict/u);
    expect(existsSync(executable)).toBe(true);
  });
});

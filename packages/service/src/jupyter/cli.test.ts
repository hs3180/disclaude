import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatalayerJupyterClient } from '@disclaude/core/jupyter';
import { SkillsRegistry } from '../../../core/src/skills/skills-registry.js';
import {
  parseNotebookOptions,
  runNotebookCommand,
  withNotebookLock,
  type NotebookCLIConnection,
} from './cli.js';
import { DatalayerRunStore } from './datalayer-run-store.js';
import { JupyterProjectConfigStore } from './project-config-store.js';
import { notebookIdentifier } from './notebook-tools.js';

const roots: string[] = [];
const root = () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'disclaude-jupyter-cli-'))
  );
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) {
    fs.rmSync(directory, { recursive: true });
  }
});
const { signal } = new AbortController();
const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../../../../', import.meta.url));

function connection() {
  const doc = { documentId: 'document-1', close: vi.fn() };
  const client = {
    openDocument: vi.fn(() => Promise.resolve(doc)),
    response: vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))),
    json: vi.fn(() => Promise.resolve({})),
    notebookEntry: () => 'https://remote.invalid/lab/tree/research.ipynb',
  };
  const resolve = vi.fn(() =>
    Promise.resolve({
      client: client as unknown as DatalayerJupyterClient,
      connectionId: 'configured',
      namespace: 'endpoint-fingerprint',
    })
  );
  return { client, doc, resolve };
}

describe('Optional Jupyter CLI boundary', () => {
  it('discovers the shipped Skill using the existing registry', () => {
    const resolution = new SkillsRegistry([{ kind: 'builtin', root: repository }]).resolve();
    expect(resolution.skills.find((skill) => skill.name === 'jupyter')).toMatchObject({
      reference: 'skills/jupyter/SKILL.md',
    });
    expect(resolution.diagnostics.filter((d) => d.name === 'jupyter')).toEqual([]);
  });

  it('rejects unknown, repeated, conflicting and misapplied options', () => {
    for (const args of [
      ['list', '--unknown', 'x'],
      ['list', '--interactive', '--no-interactive'],
      ['check', '--password-env', 'P', '--token-env', 'T'],
      ['link'],
      ['list', '--path', 'x.ipynb'],
      ['check', '--input-file', '-'],
      ['status', '--input-file', '-', '--input-file', 'x'],
    ]) {
      expect(() => parseNotebookOptions(args)).toThrow();
    }
    expect(parseNotebookOptions(['status', '--input-file', '-', '--no-interactive'])).toMatchObject(
      { command: 'status', inputFile: '-', interactive: false }
    );
  });

  it('lists schemas and references without reading credentials, creating files or connecting', async () => {
    const directory = root();
    const resolved = vi.fn(() => {
      throw new Error('must not resolve credentials');
    });
    for (const command of ['tools', 'list']) {
      const data = await runNotebookCommand(
        parseNotebookOptions([command, '--project-dir', directory]),
        resolved,
        signal
      );
      expect(data).toBeDefined();
    }
    expect(resolved).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([]);
    await expect(
      runNotebookCommand(
        parseNotebookOptions(['list', '--project-dir', directory, '--input-file', '-']),
        resolved,
        signal,
        () => '{"unexpected":true}'
      )
    ).rejects.toThrow('Invalid Notebook command input');
  });

  it('links a stable remote identity, closes its RTC socket, then unlinks locally', async () => {
    const directory = root();
    const f = connection();
    const linked = await runNotebookCommand(
      parseNotebookOptions(['link', '--path', 'research.ipynb', '--project-dir', directory]),
      f.resolve,
      signal
    );
    expect(linked).toMatchObject({
      documentId: 'document-1',
      serverNamespace: 'endpoint-fingerprint',
    });
    expect(f.doc.close).toHaveBeenCalledOnce();
    expect(f.client.json).not.toHaveBeenCalled();
    f.resolve.mockClear();
    expect(
      await runNotebookCommand(
        parseNotebookOptions(['unlink', '--path', 'research.ipynb', '--project-dir', directory]),
        f.resolve,
        signal
      )
    ).toEqual({ removed: true });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(directory, '.jupyter', 'cli.lock'))).toBe(false);
  });

  it('creates only the selected remote path and refuses a subsequent overwrite', async () => {
    const directory = root();
    const f = connection();
    const options = parseNotebookOptions([
      'create',
      '--path',
      'research.ipynb',
      '--project-dir',
      directory,
    ]);
    await runNotebookCommand(options, f.resolve, signal);
    expect(f.client.json).toHaveBeenCalledWith(
      'api/contents/research.ipynb',
      'PUT',
      expect.objectContaining({ type: 'notebook' })
    );
    f.client.response.mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(runNotebookCommand(options, f.resolve, signal)).rejects.toThrow('already exists');
    expect(f.client.json).toHaveBeenCalledOnce();
  });

  it('rejects traversal before credentials or remote writes, preserving malformed config', async () => {
    const directory = root();
    const f = connection();
    await expect(
      runNotebookCommand(
        parseNotebookOptions(['create', '--path', '../other.ipynb', '--project-dir', directory]),
        f.resolve,
        signal
      )
    ).rejects.toThrow('relative Notebook path');
    fs.writeFileSync(path.join(directory, '.jupyter', 'config.json'), 'broken');
    await expect(
      runNotebookCommand(
        parseNotebookOptions(['create', '--path', 'research.ipynb', '--project-dir', directory]),
        f.resolve,
        signal
      )
    ).rejects.toThrow('Invalid');
    expect(f.resolve).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(directory, '.jupyter', 'config.json'), 'utf8')).toBe('broken');
  });

  it('keeps concurrent commands out of the Project journal and releases after failure', async () => {
    const directory = root();
    let release!: () => void;
    const held = withNotebookLock(
      directory,
      () =>
        new Promise<void>((done) => {
          release = done;
        })
    );
    expect(fs.readFileSync(path.join(directory, '.jupyter', 'cli.lock', 'pid'), 'utf8')).toBe(
      String(process.pid)
    );
    await expect(withNotebookLock(directory, () => Promise.resolve())).rejects.toMatchObject({
      code: 'EEXIST',
    });
    release();
    await held;
    await expect(
      withNotebookLock(directory, () => Promise.reject(new Error('operation failed')))
    ).rejects.toThrow('operation failed');
    expect(fs.existsSync(path.join(directory, '.jupyter', 'cli.lock'))).toBe(false);
  });

  it('rejects a symlinked Project state directory before writing outside the Project', async () => {
    const directory = root();
    const outside = root();
    fs.symlinkSync(outside, path.join(directory, '.jupyter'));
    await expect(withNotebookLock(directory, () => Promise.resolve())).rejects.toThrow('Unsafe');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('queries cached original results in a new CLI invocation without network or RTC', async () => {
    const directory = root();
    const reference = {
      connectionId: 'configured',
      serverNamespace: 'endpoint-fingerprint',
      documentId: 'document-1',
      contentPath: 'research.ipynb',
    };
    new JupyterProjectConfigStore(directory).linkNotebook(reference);
    const journal = new DatalayerRunStore(directory);
    journal.reserve('original', {
      ...reference,
      cellId: 'cell',
      sourceHash: 'a'.repeat(64),
      kernelId: 'original-kernel',
    });
    journal.update('original', {
      state: 'completed',
      observation: {
        state: 'completed',
        result: { outputs: [{ output_type: 'stream', text: 'cached result' }] },
      },
    });
    const resolved = vi.fn((): Promise<NotebookCLIConnection> => {
      throw new Error('offline');
    });
    const options = parseNotebookOptions([
      'status',
      '--project-dir',
      directory,
      '--input-file',
      '-',
    ]);
    expect(
      await runNotebookCommand(options, resolved, signal, () =>
        JSON.stringify({ notebookId: notebookIdentifier(reference), runId: 'original' })
      )
    ).toMatchObject({
      state: 'completed',
      kernelId: 'original-kernel',
      result: { outputs: [{ text: 'cached result' }] },
    });
    expect(resolved).not.toHaveBeenCalled();
  });

  it('emits one JSON result in the real public CLI with no SDK/config initialization', async () => {
    const directory = root();
    const env = { ...process.env, JUPYTERLAB_HOST: '', JUPYTERLAB_PASS: '', JUPYTERLAB_TOKEN: '' };
    for (const command of ['tools', 'list']) {
      const result = await execute(
        process.execPath,
        [
          path.join(repository, 'bin/disclaude.js'),
          'jupyter',
          command,
          '--project-dir',
          directory,
          '--no-interactive',
        ],
        { cwd: directory, env, timeout: 15000 }
      );
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command });
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(result.stderr).not.toContain('Configuration file loaded');
    }
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});

/** First-run workspace selection, before importing Config or starting services. */
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, rename, rm, link, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import * as yaml from 'js-yaml';
import { discoverConfigFile } from '@disclaude/core/config-discovery';

export function workspaceSelection(value: string, home = homedir()): string {
  const input = value.trim() || join(home, 'disclaude-workspace');
  const expanded = input === '~' ? home : input.startsWith('~/') ? join(home, input.slice(2)) : input;
  if (/[\0\r\n]/.test(expanded)) {throw new Error('Workspace path contains invalid characters.');}
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** Validate existing state without creating a directory before confirmation. */
export async function validateWorkspaceSelection(path: string): Promise<void> {
  let parent = path;
  while (true) {
    try {
      const stat = await lstat(parent);
      // access follows symlinks; stat target explicitly for directory validation.
      const { stat: follow } = await import('node:fs/promises');
      if (!(stat.isDirectory() || (stat.isSymbolicLink() && (await follow(parent).catch(() => { throw new Error(`Cannot resolve workspace symlink: ${parent}`); })).isDirectory()))) {
        throw new Error(`Not a directory: ${parent}`);
      }
      await access(parent, constants.W_OK | constants.X_OK);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {throw error;}
      const next = dirname(parent);
      if (next === parent) {throw error;}
      parent = next;
    }
  }
}

export async function setupWorkspaceOnFirstRun(): Promise<void> {
  if (process.env.DISCLAUDE_WORKSPACE_DIR?.trim()) {return;}
  const found = discoverConfigFile();
  if (found.path && !found.exists) {throw new Error(`Configuration file does not exist: ${found.path}`);}
  const configPath = found.path || join(homedir(), '.disclaude', 'disclaude.config.yaml');
  const original = found.exists ? await readFile(configPath, 'utf8') : undefined;
  let parsed: unknown;
  try {
    parsed = original === undefined ? {} : yaml.load(original);
  } catch {
    // YAML exception snippets may contain credentials from the source config.
    throw new Error(`Cannot parse configuration: ${configPath}. Fix the YAML before workspace setup.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Configuration must be a YAML mapping: ${configPath}`);
  }
  const config = parsed as Record<string, unknown>;
  const workspace = config.workspace as { dir?: unknown } | undefined;
  if (workspace?.dir !== undefined) {return;} // Existing explicit settings remain authoritative, including invalid ones.
  const configuredEnv = config.env as Record<string, unknown> | undefined;
  if (typeof configuredEnv?.DISCLAUDE_WORKSPACE_DIR === 'string' && configuredEnv.DISCLAUDE_WORKSPACE_DIR.trim()) {return;}
  if (config.workspace !== undefined && (!workspace || typeof workspace !== 'object' || Array.isArray(workspace))) {
    throw new Error(`Invalid workspace configuration: ${configPath}`);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Workspace setup required. Run "disclaude start" in a terminal, or set workspace.dir to an existing absolute directory in your config (or set DISCLAUDE_WORKSPACE_DIR).');
  }
  const ui = createInterface({ input: process.stdin, output: process.stdout });
  let cancelled = false;
  const abort = new AbortController();
  ui.on('SIGINT', () => { cancelled = true; abort.abort(); ui.close(); });
  ui.on('close', () => { cancelled = true; abort.abort(); });
  try {
    console.log('\nSet up your workspace\nTasks, downloads and results will be saved here. Existing files will be retained.');
    while (true) {
      const answer = await ui.question(`Workspace directory [${join(homedir(), 'disclaude-workspace')}]: `, { signal: abort.signal });
      if (cancelled) {throw new Error('Workspace setup cancelled.');}
      let selected: string;
      try {
        selected = workspaceSelection(answer);
        await validateWorkspaceSelection(selected);
      } catch (error) {
        console.log(`Cannot use this workspace: ${(error as Error).message}`);
        continue;
      }
      const confirm = await ui.question(`Use ${selected}? [y/N]: `, { signal: abort.signal });
      if (cancelled || !/^y(es)?$/i.test(confirm.trim())) {throw new Error('Workspace setup cancelled.');}
      // Refuse a concurrent config edit; never overwrite another setup's result.
      const latest = await readFile(configPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {return undefined;}
        throw error;
      });
      if (latest !== original) {throw new Error('Configuration changed during setup. Please retry.');}
      await mkdir(selected, { recursive: true });
      await validateWorkspaceSelection(selected);
      await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
      const temporary = join(dirname(configPath), `.workspace-setup-${randomUUID()}.yaml`);
      try {
        await writeFile(temporary, yaml.dump({ ...config, workspace: { ...workspace, dir: selected } }, { lineWidth: -1 }), { flag: 'wx', mode: 0o600 });
        if (original === undefined) {await link(temporary, configPath);} // exclusive publish for new installs
        else {
          if ((await lstat(configPath)).isSymbolicLink()) {throw new Error('Use the configuration file target directly, not a symlink, for setup.');}
          if (await readFile(configPath, 'utf8') !== original) {throw new Error('Configuration changed during setup. Please retry.');}
          await rename(temporary, configPath);
        }
      } finally { await rm(temporary, { force: true }); }
      process.env.DISCLAUDE_CONFIG_PATH = configPath;
      console.log(`Workspace saved: ${selected}\nConfiguration: ${configPath}`);
      return;
    }
  } finally { ui.close(); }
}

import fs from 'node:fs';
import path from 'node:path';
import type { DatalayerJupyterClient } from '@disclaude/core/jupyter';
import { NotebookTools, createArtifactDirectory, notebookIdentifier } from './notebook-tools.js';
import { JupyterProjectConfigStore } from './project-config-store.js';

const commands = [
  'list',
  'describe',
  'read-cell',
  'insert-cell',
  'edit-cell',
  'move-cell',
  'delete-cell',
  'execute',
  'status',
  'stop',
  'interrupt',
  'observe-image',
  'import-file',
  'export',
  'download-report',
];
const management = ['tools', 'check', 'link', 'create', 'unlink'];

export const notebookHelp = `Usage: disclaude jupyter <command> [options]

Commands:
  tools                 Show command input schemas; no connection required
  check                 Inspect the configured Datalayer interfaces
  link --path PATH      Link an existing remote .ipynb to this Project
  create --path PATH    Create and link a new remote .ipynb; refuse overwrite
  unlink --path PATH    Remove a local reference; retain remote Notebook/kernel
  ${commands.join(', ')}
                        Use the JSON schema from tools and --input-file FILE

Options:
  --project-dir DIR     Project/workspace directory (default: current directory)
  --input-file FILE     JSON object; '-' reads stdin (default: {} for list)
  --path PATH           Relative remote Contents .ipynb path for link/create/unlink
  --connection-id ID    Local connection label (default: configured)
  --jupyter URL         Endpoint or 'configured' (default: configured)
  --env-file FILE       Private .env (default: current-directory .env)
  --password-env NAME   Password environment key (default: JUPYTERLAB_PASS)
  --token-env NAME      Token environment key (default: JUPYTERLAB_TOKEN)
  --interactive        Prompt for credentials with hidden input
  --no-interactive     Never prompt (for agent/automation calls)

Credentials: environment > .env > interactive input. Connection is lazy.
Each command closes its RTC sockets. Kernel memory stays on remote Jupyter.
execute submits once and returns runId; use status/stop for the original run.
interrupt targets an existing kernelId, or a uniquely bound notebookId; no runId.
It affects that kernel's current execution. HTTP 204 means accepted only;
executionState remains unknown. It does not confirm termination or queue clearing.
Chat /stop stops inference only. It does not confirm remote kernel cancellation.
Reports/images become persistent Project artifacts; send them with channel.
patch <action> remains the separate Jupyter Terminal repair installer.`;

export interface NotebookCLIOptions {
  command: string;
  projectDir: string;
  connectionId: string;
  jupyter: string;
  inputFile?: string;
  contentPath?: string;
  envFile?: string;
  passwordEnv?: string;
  tokenEnv?: string;
  interactive?: boolean;
}
export interface NotebookCLIConnection {
  client: DatalayerJupyterClient;
  connectionId: string;
  namespace: string;
}

const interruptCommand = {
  command: 'interrupt',
  description:
    'Interrupt an explicitly selected existing kernel, preserving its identity and memory. No runId required. HTTP 204 only acknowledges the request; query the original execution separately. Never a fallback for stop.',
  inputSchema: {
    type: 'object',
    properties: {
      kernelId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,256}$' },
      notebookId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    },
    anyOf: [{ required: ['kernelId'] }, { required: ['notebookId'] }],
    additionalProperties: false,
  },
};

/** Resolve only existing bindings. No RTC connection, execution journal or kernel creation. */
async function interruptKernel(
  root: string,
  input: unknown,
  connection: () => Promise<NotebookCLIConnection>,
  signal: AbortSignal
): Promise<unknown> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((field) => !['kernelId', 'notebookId'].includes(field))
  ) {
    throw new Error('Invalid kernel interrupt input; read its schema with jupyter tools');
  }
  const args = input as { kernelId?: unknown; notebookId?: unknown };
  if (
    (!args.kernelId && !args.notebookId) ||
    (args.kernelId !== undefined &&
      (typeof args.kernelId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(args.kernelId))) ||
    (args.notebookId !== undefined &&
      (typeof args.notebookId !== 'string' || !/^[a-f0-9]{64}$/.test(args.notebookId)))
  ) {
    throw new Error('Invalid kernel interrupt target; read its schema with jupyter tools');
  }
  signal.throwIfAborted();
  const { client, connectionId, namespace } = await connection();
  const refused = (state: string): unknown => ({
    state,
    executionState: 'unknown',
    phase: 'resolve_notebook',
    ...(typeof args.kernelId === 'string' ? { kernelId: args.kernelId } : {}),
  });
  let kernelId = args.kernelId as string | undefined;
  if (typeof args.notebookId === 'string') {
    const loaded = new JupyterProjectConfigStore(root).listNotebookReferences();
    if (!loaded.ok) {
      throw new Error('Project Notebook references cannot be verified');
    }
    const ref = loaded.data.find((value) => notebookIdentifier(value) === args.notebookId);
    if (!ref) {
      return refused('missing_notebook');
    }
    if (ref.connectionId !== connectionId || ref.serverNamespace !== namespace) {
      return refused('endpoint_changed');
    }
    try {
      if (ref.documentId && (await client.documentPath(ref.documentId)) !== ref.contentPath) {
        return refused('notebook_moved');
      }
      const data = await client.json('api/sessions');
      if (
        !Array.isArray(data) ||
        data.some(
          (session: { path?: unknown; kernel?: { id?: unknown } } | null) =>
            !session ||
            typeof session.path !== 'string' ||
            typeof session.kernel?.id !== 'string' ||
            !/^[A-Za-z0-9_-]{1,256}$/.test(session.kernel.id)
        )
      ) {
        return refused('unknown');
      }
      const sessions = data as Array<{ path: string; kernel: { id: string } }>;
      const ids = [
        ...new Set(sessions.filter((s) => s.path === ref.contentPath).map((s) => s.kernel.id)),
      ];
      if (!ids.length) {
        return refused('missing_kernel');
      }
      if (ids.length !== 1) {
        return refused('ambiguous_binding');
      }
      const [selected] = ids;
      if (kernelId && kernelId !== selected) {
        return refused('binding_changed');
      }
      if (sessions.some((s) => s.kernel.id === selected && s.path !== ref.contentPath)) {
        return refused('shared_kernel');
      }
      kernelId = selected;
    } catch {
      signal.throwIfAborted();
      return refused('unknown');
    }
  }
  signal.throwIfAborted();
  if (!kernelId) {
    throw new Error('Kernel interrupt needs an explicit existing target');
  }
  return client.interruptKernel(kernelId, signal);
}

export function parseNotebookOptions(args: string[]): NotebookCLIOptions {
  const options: NotebookCLIOptions = {
    command: args[0],
    projectDir: process.cwd(),
    connectionId: 'configured',
    jupyter: 'configured',
  };
  if (![...commands, ...management].includes(options.command)) {
    throw new Error('Unknown Jupyter command');
  }
  const names = {
    '--project-dir': 'projectDir',
    '--input-file': 'inputFile',
    '--path': 'contentPath',
    '--connection-id': 'connectionId',
    '--jupyter': 'jupyter',
    '--env-file': 'envFile',
    '--password-env': 'passwordEnv',
    '--token-env': 'tokenEnv',
  } as const;
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (['--interactive', '--no-interactive'].includes(flag)) {
      if (seen.has('interactive')) {
        throw new Error('Repeated interactive option');
      }
      seen.add('interactive');
      options.interactive = flag === '--interactive';
      continue;
    }
    const name = names[flag as keyof typeof names];
    if (!name || seen.has(name) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Unknown, repeated or empty Jupyter option');
    }
    seen.add(name);
    options[name] = args[++i];
  }
  if (options.passwordEnv && options.tokenEnv) {
    throw new Error('Choose one authentication mode');
  }
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(options.connectionId)) {
    throw new Error('Invalid connection ID');
  }
  if (['link', 'create', 'unlink'].includes(options.command) !== !!options.contentPath) {
    throw new Error('--path is required only for link/create/unlink');
  }
  if (!commands.includes(options.command) && options.inputFile) {
    throw new Error('--input-file is only valid for Notebook operations');
  }
  return options;
}

/** One local command lock prevents CLI processes from losing journal updates. */
export async function withNotebookLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const directory = path.join(fs.realpathSync(root), '.jupyter');
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  const state = fs.lstatSync(directory);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error('Unsafe Jupyter directory');
  }
  const lock = path.join(directory, 'cli.lock');
  fs.mkdirSync(lock, { mode: 0o700 });
  try {
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid), { mode: 0o600, flag: 'wx' });
    return await operation();
  } finally {
    fs.rmSync(lock, { recursive: true });
  }
}

export async function runNotebookCommand(
  options: NotebookCLIOptions,
  connection: () => Promise<NotebookCLIConnection>,
  signal: AbortSignal,
  readInput = (file: string): string => fs.readFileSync(file === '-' ? 0 : file, 'utf8')
): Promise<unknown> {
  const root = fs.realpathSync(options.projectDir);
  const tools = new NotebookTools({
    projectDir: root,
    useClient: async (id, namespace, operation) => {
      const resolved = await connection();
      if (resolved.connectionId !== id || resolved.namespace !== namespace) {
        throw new Error('Project reference belongs to another configured endpoint');
      }
      signal.throwIfAborted();
      return await operation(resolved.client);
    },
  });
  try {
    if (options.command === 'tools') {
      return [
        ...tools.tools.map(({ name, description, inputSchema }) => ({
          command: name.replace(/^notebook_/, '').replaceAll('_', '-'),
          description,
          inputSchema,
        })),
        interruptCommand,
      ];
    }
    if (options.command === 'list') {
      const raw = options.inputFile ? readInput(options.inputFile) : '{}';
      if (Buffer.byteLength(raw) > 300000) {
        throw new Error('Notebook input exceeds its limit');
      }
      return await tools.tools[0].execute(JSON.parse(raw) as Record<string, unknown>, { signal });
    }
    if (options.command === 'check') {
      return await (await connection()).client.inspectConnection();
    }
    return await withNotebookLock(root, async () => {
      signal.throwIfAborted();
      if (['link', 'create', 'unlink'].includes(options.command)) {
        if (!options.contentPath) {
          throw new Error('Notebook path is required');
        }
        const ref = {
          connectionId: options.connectionId,
          serverNamespace: 'validation',
          contentPath: options.contentPath,
        };
        // Validate path before accessing the remote resource, without writing config.
        if (
          !/^(?!\/)(?!.*\\)(?!.*[\u0000-\u001f\u007f])(?:[^/]+\/)*[^/]+\.ipynb$/i.test(
            ref.contentPath
          ) ||
          ref.contentPath !== ref.contentPath.trim() ||
          ref.contentPath.split('/').some((s) => ['.', '..'].includes(s)) ||
          ref.contentPath.length > 1024
        ) {
          throw new Error('Invalid relative Notebook path');
        }
        const store = new JupyterProjectConfigStore(root);
        const loaded = store.listNotebookReferences();
        if (!loaded.ok) {
          throw new Error(loaded.error);
        }
        if (options.command === 'unlink') {
          const match = loaded.data.find(
            (r) => r.connectionId === ref.connectionId && r.contentPath === ref.contentPath
          );
          if (!match) {
            return { removed: false };
          }
          const result = store.unlinkNotebook(match);
          if (!result.ok) {
            throw new Error(result.error);
          }
          return { removed: result.data };
        }
        const { client, namespace } = await connection();
        ref.serverNamespace = namespace;
        if (options.command === 'create') {
          const route = `api/contents/${ref.contentPath.split('/').map(encodeURIComponent).join('/')}`;
          const response = await client.response(`${route}?content=0`);
          const missing = response.status === 404;
          await response.body?.cancel();
          if (!missing) {
            throw new Error('Remote Notebook already exists or cannot be verified');
          }
          signal.throwIfAborted();
          await client.json(route, 'PUT', {
            type: 'notebook',
            format: 'json',
            content: { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] },
          });
        }
        const doc = await client.openDocument(ref.contentPath);
        try {
          signal.throwIfAborted();
          const result = store.linkNotebook({ ...ref, documentId: doc.documentId });
          if (!result.ok) {
            throw new Error(result.error);
          }
          return {
            ...result.data,
            notebookId: notebookIdentifier(result.data),
            entry: client.notebookEntry(ref.contentPath),
          };
        } finally {
          doc.close();
        }
      }
      const raw = options.inputFile ? readInput(options.inputFile) : '{}';
      if (Buffer.byteLength(raw) > 300000) {
        throw new Error('Notebook input exceeds its limit');
      }
      if (options.command === 'interrupt') {
        return interruptKernel(root, JSON.parse(raw) as unknown, connection, signal);
      }
      const name = `notebook_${options.command.replaceAll('-', '_')}`;
      const tool = tools.tools.find((t) => t.name === name);
      if (!tool) {
        throw new Error('Unknown Notebook operation');
      }
      const result = await tool.execute(JSON.parse(raw) as Record<string, unknown>, { signal });
      return materializeImages(root, result);
    });
  } finally {
    await tools.close();
  }
}

function materializeImages(root: string, result: unknown): unknown {
  const media = result as {
    format?: string;
    data?: unknown;
    images?: Array<{ mimeType: string; data: string }>;
  };
  if (media.format !== 'disclaude.tool-result.v1' || !media.images?.length) {
    return result;
  }
  const directory = createArtifactDirectory(root);
  return {
    data: media.data,
    images: media.images.map((image, index) => {
      const filePath = path.join(
        directory,
        `image-${index}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`
      );
      fs.writeFileSync(filePath, Buffer.from(image.data, 'base64'), { mode: 0o600, flag: 'wx' });
      return { mimeType: image.mimeType, filePath };
    }),
  };
}

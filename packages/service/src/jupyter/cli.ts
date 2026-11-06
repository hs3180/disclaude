import fs from 'node:fs';
import path from 'node:path';
import { JupyterDiagnosticError, type DatalayerJupyterClient } from '@disclaude/core/jupyter';
import { NotebookTools, createArtifactDirectory, notebookIdentifier } from './notebook-tools.js';
import { JupyterProjectConfigStore } from './project-config-store.js';

const commands = [
  'list',
  'runtime-probe',
  'describe',
  'read-cell',
  'insert-cell',
  'edit-cell',
  'move-cell',
  'delete-cell',
  'execute',
  'status',
  'reconcile',
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
  link                  Link an existing remote .ipynb to this Project
  create                Create and link a new remote .ipynb; refuse overwrite
  unlink                Remove a local reference; retain remote Notebook/kernel
  ${commands.join(', ')}
                        Every command above takes exactly one JSON object through
                        --input-file; read each schema with jupyter tools.
                        link/create/unlink also accept the --path shorthand for
                        the JSON path field.

Options:
  --project-dir DIR     Project/workspace directory (default: current directory)
  --input-file FILE     JSON object; '-' reads stdin (default: {} for list)
  --path PATH           Shorthand for the link/create/unlink JSON path field
  --connection-id ID    Local connection label (default: configured)
  --jupyter URL         Endpoint or 'configured' (default: configured)
  --env-file FILE       Private .env (otherwise cwd, Project, workspace marker, environment workspace)
  --password-env NAME   Password environment key (default: JUPYTERLAB_PASS)
  --token-env NAME      Token environment key (default: JUPYTERLAB_TOKEN)
  --interactive        Prompt for credentials with hidden input
  --no-interactive     Never prompt (for agent/automation calls)
  --verbose            Emit safe credential/HTTP phase records on stderr

Credentials: environment > .env > interactive input. Connection is lazy.
The selected env-file path is reported; credential values and cookies stay private.
list shows local Project references, not remote inventory; auth is configured/unresolved,
and remote authentication remains not_checked. No list/check result proves execution acceptance.
Failures expose error.layer/code/status/serverBody/hint; exit codes: schema=2,
auth=3, dns=4, tcp=5, http=6, cas=7, local=8, unknown=1.
Each command closes its RTC sockets. Kernel memory stays on remote Jupyter.
execute submits once and returns runId; use status/stop for the original run.
status labels source as live or local-journal; connection failures retain last-known facts.
reconcile queries every nonterminal original handle after restoring credentials/connection.
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
  verbose?: boolean;
}
export interface NotebookCLIConnection {
  client: DatalayerJupyterClient;
  connectionId: string;
  namespace: string;
}

const runtimeProbeCommand = {
  command: 'runtime-probe',
  description: 'Probe an existing kernel with fixed host-owned code. Returns a hashed host ID and sorted GPU UUIDs; unknown never means safe to run. No Notebook writeback.',
  inputSchema: {
    type: 'object', properties: { kernelId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,256}$' } },
    required: ['kernelId'], additionalProperties: false,
  },
  outputSchema: {
    type: 'object', required: ['schema', 'host', 'gpus'],
    description: 'disclaude.jupyter-runtime.v1; host.id is sha256:<64 lowercase hex> or null; gpus.uuids is a sorted unique GPU-* list or null with state=unknown.',
  },
};

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

/** One JSON object input for every lifecycle command; identical to the --path flag. */
const lifecycleInputSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'Relative remote Contents .ipynb path: no leading slash, backslash, "."/".." segment or control characters, at most 1024 bytes; identical to the --path shorthand.',
    },
  },
  required: ['path'],
  additionalProperties: false,
};
const checkCommand = {
  command: 'check',
  description:
    'Inspect the configured Datalayer interfaces through one authenticated connection. Takes no input fields; creates no Notebook, document or kernel.',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};
const linkCommand = {
  command: 'link',
  description:
    'Link an existing remote .ipynb to this Project: open it once, store its stable document identity and return the opaque notebookId used by every later command. Never creates, overwrites or restarts a resource.',
  inputSchema: lifecycleInputSchema,
};
const createCommand = {
  command: 'create',
  description:
    'Create and link a new remote .ipynb at the selected relative path; an existing resource is never overwritten. The remote parent directory must already exist. The new Notebook starts with zero cells; describe shows the RTC-seeded phantom empty first cell until the first appended insert-cell removes it.',
  inputSchema: lifecycleInputSchema,
};
const unlinkCommand = {
  command: 'unlink',
  description:
    'Remove one local Project reference selected by path; the remote Notebook, its content and its kernel are retained. Returns removed:false when no reference matches.',
  inputSchema: lifecycleInputSchema,
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
  const invalid = (message: string): never => {
    throw new JupyterDiagnosticError({ layer: 'schema', code: 'invalid_options', phase: 'options', message,
      hint: 'Read disclaude jupyter --help and use the command input schema from jupyter tools.', outcome: 'not-submitted' });
  };
  const options: NotebookCLIOptions = {
    command: args[0],
    projectDir: process.cwd(),
    connectionId: 'configured',
    jupyter: 'configured',
  };
  if (![...commands, ...management].includes(options.command)) {
    invalid('Unknown Jupyter command');
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
    if (flag === '--verbose') {
      if (seen.has('verbose')) { invalid('Repeated verbose option'); }
      seen.add('verbose'); options.verbose = true; continue;
    }
    if (['--interactive', '--no-interactive'].includes(flag)) {
      if (seen.has('interactive')) {
        invalid('Repeated interactive option');
      }
      seen.add('interactive');
      options.interactive = flag === '--interactive';
      continue;
    }
    const name = names[flag as keyof typeof names];
    if (!name || seen.has(name) || !args[i + 1] || args[i + 1].startsWith('--')) {
      invalid('Unknown, repeated or empty Jupyter option');
    }
    seen.add(name);
    options[name] = args[++i];
  }
  if (options.passwordEnv && options.tokenEnv) {
    invalid('Choose one authentication mode');
  }
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(options.connectionId)) {
    invalid('Invalid connection ID');
  }
  const lifecycle = ['link', 'create', 'unlink'].includes(options.command);
  if (lifecycle && !!options.contentPath === !!options.inputFile) {
    invalid('link/create/unlink take exactly one input: --path PATH or --input-file with {"path":...}');
  }
  if (!lifecycle && (options.contentPath || (!commands.includes(options.command) && options.inputFile))) {
    invalid('--path is required only for link/create/unlink; --input-file is only valid for Notebook operations');
  }
  return options;
}

function notebookInput(file: string | undefined, read: (file: string) => string): unknown {
  const raw = file ? read(file) : '{}';
  if (Buffer.byteLength(raw) > 300000) {
    throw new JupyterDiagnosticError({ layer: 'schema', code: 'input_limit_exceeded', phase: 'input',
      message: 'Notebook input exceeds its limit', hint: 'Keep the command JSON input below 300000 bytes.', outcome: 'not-submitted' });
  }
  try { return JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown; }
  catch {
    throw new JupyterDiagnosticError({ layer: 'schema', code: 'invalid_json_input', phase: 'input',
      message: 'Notebook input-file is not valid JSON', hint: 'Validate one JSON object against jupyter tools; do not include shell quoting or trailing text.', outcome: 'not-submitted' });
  }
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
        throw new JupyterDiagnosticError({ layer: 'auth', code: 'endpoint_reference_mismatch', phase: 'reference',
          message: 'Project reference belongs to another configured endpoint',
          hint: 'Verify the selected env-file/endpoint and this Project reference before explicitly relinking it.', outcome: 'not-submitted' });
      }
      signal.throwIfAborted();
      return await operation(resolved.client);
    },
  });
  try {
    if (options.command === 'tools') {
      return [
        ...tools.tools.map(({ name, description, inputSchema, outputSchema }) => ({
          command: name.replace(/^notebook_/, '').replaceAll('_', '-'),
          description,
          inputSchema,
          outputSchema,
        })),
        checkCommand,
        linkCommand,
        createCommand,
        unlinkCommand,
        interruptCommand,
        runtimeProbeCommand,
      ];
    }
    if (options.command === 'list') {
      return await tools.tools[0].execute(notebookInput(options.inputFile, readInput) as Record<string, unknown>, { signal });
    }
    if (options.command === 'check') {
      return await (await connection()).client.inspectConnection();
    }
    return await withNotebookLock(root, async () => {
      signal.throwIfAborted();
      if (['link', 'create', 'unlink'].includes(options.command)) {
        // Unified input style (#5321): the same JSON object contract as every
        // other command; --path stays a shorthand for the "path" field.
        const input = options.inputFile ? notebookInput(options.inputFile, readInput) : undefined;
        if (
          input !== undefined &&
          (!input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.keys(input).length !== 1 ||
            typeof (input as { path?: unknown }).path !== 'string')
        ) {
          throw new JupyterDiagnosticError({ layer: 'schema', code: 'invalid_tool_input', phase: 'input',
            message: 'Invalid lifecycle command input; read its schema with jupyter tools',
            hint: 'Pass exactly {"path":"<relative .ipynb>"} from the command schema in jupyter tools, or use the --path shorthand.', outcome: 'not-submitted' });
        }
        const contentPath = options.contentPath ?? (input as { path: string } | undefined)?.path;
        if (!contentPath) {
          throw new Error('Notebook path is required');
        }
        const ref = {
          connectionId: options.connectionId,
          serverNamespace: 'validation',
          contentPath,
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
          throw new JupyterDiagnosticError({ layer: 'schema', code: 'invalid_notebook_path', phase: 'input',
            message: 'Invalid relative Notebook path', hint: 'Use a relative .ipynb Contents path without traversal or control characters.', outcome: 'not-submitted' });
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
          if (!missing && !response.ok) { throw await client.responseError(response, 'create-preflight'); }
          await response.body?.cancel();
          if (!missing) {
            throw new JupyterDiagnosticError({ layer: 'schema', code: 'notebook_already_exists', phase: 'create-preflight', status: response.status,
              message: 'Remote Notebook already exists; refusing overwrite', hint: 'Choose another path or explicitly link the existing Notebook.', outcome: 'not-submitted' });
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
      const input = notebookInput(options.inputFile, readInput);
      if (options.command === 'interrupt') {
        return interruptKernel(root, input, connection, signal);
      }
      if (options.command === 'runtime-probe') {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 ||
          typeof (input as { kernelId?: unknown }).kernelId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,256}$/.test((input as { kernelId: string }).kernelId)) {
          throw new Error('Invalid runtime probe input; an existing kernelId is required');
        }
        signal.throwIfAborted();
        return (await connection()).client.probeRuntime((input as { kernelId: string }).kernelId, signal);
      }
      const name = `notebook_${options.command.replaceAll('-', '_')}`;
      const tool = tools.tools.find((t) => t.name === name);
      if (!tool) {
        throw new Error('Unknown Notebook operation');
      }
      const result = await tool.execute(input as Record<string, unknown>, { signal });
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

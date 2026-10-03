import { randomUUID } from 'node:crypto';
import type { HostToolDefinition } from '../sdk/host-tools.js';
import type {
  JupyterControllerGeneration,
  JupyterExecutionPort,
  JupyterNotebookLocator,
  JupyterNotebookPort,
} from './contracts.js';

/** Authorized resources are bound by the host, never chosen by model arguments. */
export interface NotebookToolBinding {
  readonly notebook: JupyterNotebookLocator;
  readonly documents: JupyterNotebookPort;
  readonly executions: JupyterExecutionPort;
  /** Re-read authority at each operation; a stored execution handle is not a lease. */
  controller(): Promise<JupyterControllerGeneration>;
  kernel(): Promise<{ kernelId: string; kernelIncarnation: string }>;
}

const string = { type: 'string', minLength: 1 };
const outputSchema = { type: 'object' };

function schema(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function requiredString(input: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = input[key];
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${key} must be a ${allowEmpty ? '' : 'non-empty '}string`);
  }
  return value;
}

/** The same document and execution tools can be registered by any native adapter. */
export function createNotebookTools(binding: NotebookToolBinding): HostToolDefinition[] {
  return [
    {
      name: 'notebook_read_cell',
      description: 'Read the current shared cell, including synchronized unsaved human edits.',
      inputSchema: schema({ cellId: string }),
      outputSchema,
      execute: async (input, { signal }) => {
        signal.throwIfAborted();
        return await binding.documents.readCell(binding.notebook, requiredString(input, 'cellId'));
      },
    },
    {
      name: 'notebook_edit_cell',
      description:
        'Change one cell only if its live revision, source hash and current ownership still match. Handle conflicts by reading the returned snapshot.',
      inputSchema: schema({
        cellId: string,
        expectedRevision: string,
        expectedSourceHash: string,
        source: { type: 'string' },
      }),
      outputSchema,
      execute: async (input, { signal }) => {
        const controller = await binding.controller();
        signal.throwIfAborted();
        return binding.documents.editCellSource({
          notebook: binding.notebook,
          cellId: requiredString(input, 'cellId'),
          expectedRevision: requiredString(input, 'expectedRevision'),
          expectedSourceHash: requiredString(input, 'expectedSourceHash'),
          source: requiredString(input, 'source', true),
          controller,
        });
      },
    },
    {
      name: 'notebook_run_cell',
      description:
        'Submit the exact versioned source to the authorized kernel. An accepted request is still running; query its runId. Never replay an unknown submission.',
      inputSchema: schema({
        cellId: string,
        expectedRevision: string,
        sourceHash: string,
        source: { type: 'string' },
      }),
      outputSchema,
      execute: async (input, { signal }) => {
        const controller = await binding.controller();
        const kernel = await binding.kernel();
        signal.throwIfAborted();
        return binding.executions.submit({
          target: {
            notebook: binding.notebook,
            cellId: requiredString(input, 'cellId'),
            expectedRevision: requiredString(input, 'expectedRevision'),
            sourceHash: requiredString(input, 'sourceHash'),
            ...kernel,
            runId: randomUUID(),
            controller,
          },
          source: requiredString(input, 'source', true),
        });
      },
    },
    {
      name: 'notebook_execution_status',
      description: 'Reconcile a persisted run by its runId without resubmitting any code.',
      inputSchema: schema({ runId: string }),
      outputSchema,
      execute: async (input, { signal }) => {
        signal.throwIfAborted();
        return await binding.executions.getStatus(binding.notebook, requiredString(input, 'runId'));
      },
    },
    {
      name: 'notebook_stop_execution',
      description:
        'Request stopping this run with current ownership. A requested stop needs a later status check before claiming cancellation.',
      inputSchema: schema({ runId: string }),
      outputSchema,
      execute: async (input, { signal }) => {
        const runId = requiredString(input, 'runId');
        const current = await binding.executions.getStatus(binding.notebook, runId);
        if (current.state === 'unknown' && !current.handle) {
          return { state: 'unknown', reason: current.reason };
        }
        const { handle } = current;
        if (
          !handle ||
          handle.runId !== runId ||
          handle.notebook.identity.connectionId !== binding.notebook.identity.connectionId ||
          handle.notebook.identity.serverNamespace !== binding.notebook.identity.serverNamespace ||
          handle.notebook.identity.documentId !== binding.notebook.identity.documentId
        ) {
          return {
            state: 'unknown',
            reason: 'Execution identity does not match the bound Notebook',
          };
        }
        const controller = await binding.controller();
        signal.throwIfAborted();
        return binding.executions.stop(handle, controller);
      },
    },
  ];
}

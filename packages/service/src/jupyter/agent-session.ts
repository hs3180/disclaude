import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  createNotebookTools,
  type JupyterControllerGeneration,
  type JupyterCoordinatorClient,
  type JupyterExecutionObservation,
  type JupyterNotebookLocator,
  type ToolDefinition,
  type ToolContext,
  type NotebookToolBinding,
} from '@disclaude/core';
import { JupyterConnections } from './connections.js';
import {
  JupyterProjectConfigStore,
  type JupyterNotebookReference,
} from './project-config-store.js';
import { NotebookRunStore, handleTarget } from './run-store.js';
import { DatalayerNotebookAgentSession } from './datalayer-agent-session.js';

export interface NotebookAgentContext {
  workingDir: string;
  /** Conversation identity, independent of the selected Harness/model. */
  conversationKey: string;
  currentWorkingDir(): string;
}

export type NotebookAgentSessionFactory = (
  context: NotebookAgentContext
) => NotebookSession | undefined;

/** Agent-facing lifecycle only; backend protocols belong to their session implementations. */
export interface NotebookSession {
  readonly tools: ToolDefinition[];
  readonly inactive: boolean;
  pause(): void;
  dispose(): void;
  redactEnvironment(environment: Record<string, string | undefined>): void;
  messageContext(): Promise<string>;
  stop(): Promise<NotebookStopObservation[]>;
}

export interface NotebookStopObservation {
  runId: string;
  state: 'cancelled' | 'already_terminal' | 'ownership_lost' | 'unknown';
}

export interface NotebookStopSummary {
  cancelled: number;
  alreadyTerminal: number;
  ownershipLost: number;
  unknown: number;
  unavailable?: boolean;
}

const terminal = new Set(['completed', 'failed', 'cancelled', 'rejected', 'not_started']);
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function resourceKey(reference: JupyterNotebookReference): string {
  return createHash('sha256')
    .update(
      JSON.stringify([reference.connectionId, reference.serverNamespace, reference.documentId])
    )
    .digest('hex');
}

function locator(reference: JupyterNotebookReference): JupyterNotebookLocator {
  if (!reference.documentId) {
    throw new Error('Notebook stable identity is unverified');
  }
  return {
    identity: {
      connectionId: reference.connectionId,
      serverNamespace: reference.serverNamespace,
      documentId: reference.documentId,
    },
    contentPath: reference.contentPath,
  };
}

function sameController(
  a: JupyterControllerGeneration | undefined | null,
  b: JupyterControllerGeneration
): boolean {
  return a?.ownerId === b.ownerId && a.generation === b.generation;
}

const inputSchema = (properties: Record<string, unknown>): Record<string, unknown> => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** Native tools over host-bound resources. No Harness/CLI or Jupyter credential appears in a DTO. */
export class NotebookAgentSession {
  readonly tools: ToolDefinition[];
  private readonly config: JupyterProjectConfigStore;
  private readonly records: NotebookRunStore;
  private readonly root: string;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly owner: string;
  private paused = false;
  private stopFlight?: Promise<NotebookStopObservation[]>;
  private readonly leaseFlights = new Map<string, Promise<JupyterControllerGeneration>>();
  private readonly boundLeases = new Set<string>();

  constructor(
    private readonly context: NotebookAgentContext,
    private readonly connections: JupyterConnections,
    private readonly stopTimeoutMs = 15_000
  ) {
    this.root = fs.realpathSync(context.workingDir);
    this.config = new JupyterProjectConfigStore(this.root);
    this.records = new NotebookRunStore(this.root, context.conversationKey);
    this.owner = this.records.ownerId();
    const dummy = {} as NotebookToolBinding;
    this.tools = [
      {
        name: 'notebook_list',
        description:
          'List host-authorized Notebooks and recent persisted run IDs for this Project.',
        inputSchema: inputSchema({}),
        outputSchema: { type: 'object' },
        execute: async (_input, { signal }) => {
          signal.throwIfAborted();
          this.assertActive();
          return await this.list();
        },
      },
      {
        name: 'notebook_describe',
        description: 'Read a bounded overview of live cells, including synchronized human edits.',
        inputSchema: inputSchema({ notebookId: { type: 'string', minLength: 1 } }),
        outputSchema: { type: 'object' },
        execute: async (input, { signal }) => {
          const ref = await this.reference(String(input.notebookId));
          signal.throwIfAborted();
          this.assertActive();
          return await this.use(ref, async (client) => {
            const view = await client.describeNotebook(locator(ref));
            const control = await client.controlState(locator(ref));
            return {
              ...view,
              control,
              cells: view.cells
                .slice(0, 64)
                .map((cell) => ({ ...cell, sourcePreview: cell.sourcePreview.slice(0, 500) })),
              omittedCells: Math.max(0, view.cells.length - 64),
            };
          });
        },
      },
      {
        name: 'notebook_reconcile_submission',
        description:
          'Reconcile your persisted unknown submission by runId. The server either returns its recorded execution or permanently fences that exact attempt before proving not_started. This never sends source code, interrupts work, restarts a kernel or replays the original request. Accepted handles must use status/stop instead.',
        inputSchema: inputSchema({
          notebookId: { type: 'string', minLength: 1 },
          runId: { type: 'string', minLength: 1 },
        }),
        outputSchema: { type: 'object' },
        execute: (input, { signal }) =>
          this.tracked(async () => {
            signal.throwIfAborted();
            const ref = await this.reference(String(input.notebookId));
            signal.throwIfAborted();
            this.assertActive();
            const record = this.records.records().find((item) => item.target.runId === input.runId);
            if (
              !record ||
              record.handle ||
              resourceKey({
                ...record.target.notebook.identity,
                contentPath: record.target.notebook.contentPath,
              }) !== resourceKey(ref)
            ) {
              throw new Error(
                "Submission reconciliation requires this conversation's original unaccepted attempt"
              );
            }
            const result = await this.use(ref, (client) => {
              signal.throwIfAborted();
              this.assertActive();
              return client.reconcileSubmission(record.target);
            });
            if (result.state === 'not_started') {
              if (
                result.submissionFenced !== true ||
                JSON.stringify(handleTarget(result.target)) !==
                  JSON.stringify(handleTarget(record.target))
              ) {
                throw new Error('Submission fence does not match the original execution target');
              }
              this.records.observe(record.target.runId, 'not_started');
            } else if (result.state === 'recorded') {
              if (!result.observation.handle) {
                throw new Error('Recorded execution has no original accepted handle');
              }
              this.records.observe(
                record.target.runId,
                result.observation.state,
                result.observation.handle
              );
            }
            // Keep verified evidence even when inference was paused during the POST.
            signal.throwIfAborted();
            this.assertActive();
            return result;
          }),
      },
      {
        name: 'notebook_take_control',
        description:
          'Explicitly take Notebook automation control for a user request to resume editing or running. Read notebook_describe control first and pass its exact owner and generation (empty owner and zero if unowned). Reconcile your earlier runs first. Active foreign experiments refuse transfer. This does not interrupt or restart a kernel.',
        inputSchema: inputSchema({
          notebookId: { type: 'string', minLength: 1 },
          expectedOwnerId: { type: 'string', maxLength: 4096 },
          expectedGeneration: {
            type: 'integer',
            description:
              'Exact observed nonnegative controller generation; validated before transfer.',
          },
        }),
        outputSchema: { type: 'object' },
        execute: (input, { signal }) =>
          this.tracked(async () => {
            signal.throwIfAborted();
            this.assertActive();
            const ref = await this.reference(String(input.notebookId));
            return {
              state: 'claimed',
              controller: await this.takeControl(
                ref,
                String(input.expectedOwnerId),
                Number(input.expectedGeneration),
                signal
              ),
            };
          }),
      },
      ...createNotebookTools(dummy).map((template) => ({
        ...template,
        inputSchema: {
          ...template.inputSchema,
          properties: {
            ...(template.inputSchema.properties as Record<string, unknown>),
            notebookId: { type: 'string', minLength: 1 },
          },
          required: [...(template.inputSchema.required as string[]), 'notebookId'],
        },
        execute: (input: Record<string, unknown>, invocation: ToolContext) =>
          this.tracked(async () => {
            invocation.signal.throwIfAborted();
            this.assertActive();
            const ref = await this.reference(String(input.notebookId));
            invocation.signal.throwIfAborted();
            this.assertActive();
            const { notebookId: _notebookId, ...arguments_ } = input;
            const tool = createNotebookTools(this.binding(ref)).find(
              (item) => item.name === template.name
            );
            if (!tool) {
              throw new Error('Notebook native tool registration changed');
            }
            return tool.execute(arguments_, invocation);
          }),
      })),
    ];
  }

  private assertActive(): void {
    if (this.paused || fs.realpathSync(this.context.currentWorkingDir()) !== this.root) {
      throw new Error('Notebook operation stopped or Project changed');
    }
  }

  /** Fence new callbacks synchronously, before inference cancellation or any HTTP wait. */
  pause(): void {
    this.paused = true;
  }
  get inactive(): boolean {
    return this.paused;
  }
  dispose(): void {
    this.pause();
  }
  redactEnvironment(environment: Record<string, string | undefined>): void {
    this.connections.redactEnvironment(environment);
  }

  private async use<T>(
    ref: JupyterNotebookReference,
    operation: (client: JupyterCoordinatorClient) => Promise<T>
  ): Promise<T> {
    try {
      return await this.connections.use(ref.connectionId, ref.serverNamespace, operation);
    } catch {
      throw new Error('Jupyter operation could not be verified');
    }
  }

  private async references(): Promise<JupyterNotebookReference[]> {
    this.assertActive();
    const result = this.config.listNotebookReferences();
    if (!result.ok) {
      throw new Error('Project Notebook references cannot be verified');
    }
    if (result.data.length > 32) {
      throw new Error('Project Notebook reference limit exceeded');
    }
    const refs: JupyterNotebookReference[] = [];
    for (const ref of result.data) {
      if (ref.documentId) {
        refs.push(ref);
        continue;
      }
      const opened = await this.use<JupyterNotebookLocator>(ref, (client) =>
        client.openNotebook(ref.contentPath)
      );
      this.assertActive();
      const resolved = this.config.resolveNotebook(ref, opened.identity.documentId);
      if (!resolved.ok) {
        throw new Error('Project Notebook reference changed while resolving');
      }
      refs.push(resolved.data);
    }
    return refs;
  }

  private async reference(id: string): Promise<JupyterNotebookReference> {
    const ref = (await this.references()).find((item) => resourceKey(item) === id);
    if (!ref) {
      throw new Error('Notebook is not authorized by this Project');
    }
    return ref;
  }

  private async list(): Promise<unknown> {
    const refs = await this.references();
    return {
      notebooks: refs.map((ref) => ({ notebookId: resourceKey(ref), ...ref })),
      recentRuns: this.records
        .records()
        .sort((a, b) => b.observedAt - a.observedAt)
        .slice(0, 10)
        .map((record) => ({
          notebookId: resourceKey({
            ...record.target.notebook.identity,
            contentPath: record.target.notebook.contentPath,
          }),
          runId: record.target.runId,
          lastObservedState: record.state,
          observedAt: record.observedAt,
        })),
    };
  }

  /** Per-message context is bounded; complete source/output is read on demand. */
  async messageContext(): Promise<string> {
    const refs = await this.references();
    const overviews = [];
    for (const ref of refs.slice(0, 4)) {
      const overview = await this.use(ref, async (client) => ({
        ...(await client.describeNotebook(locator(ref))),
        control: await client.controlState(locator(ref)),
      }));
      overviews.push({
        notebookId: resourceKey(ref),
        contentPath: ref.contentPath.slice(0, 300),
        control: overview.control,
        cells: overview.cells
          .slice(0, 8)
          .map((cell) => ({ ...cell, sourcePreview: cell.sourcePreview.slice(0, 160) })),
        omittedCells: Math.max(0, overview.cells.length - 8),
      });
    }
    return `\n\n[Notebook resources]\nUse the native notebook tools for these server-owned documents. Read current revisions before changes. Kernel/data paths belong to Jupyter; this Project contains references only. Query submitted runs by their original runId. An unknown unaccepted attempt can use notebook_reconcile_submission; an absence read alone never authorizes replay. Stop acknowledgment is not confirmation.\n${JSON.stringify(
      {
        resources: {
          notebooks: refs.slice(0, 8).map((ref) => ({
            notebookId: resourceKey(ref),
            contentPath: ref.contentPath.slice(0, 300),
          })),
          omittedNotebooks: Math.max(0, refs.length - 8),
          recentRuns: this.records
            .records()
            .sort((a, b) => b.observedAt - a.observedAt)
            .slice(0, 10)
            .map((record) => ({ runId: record.target.runId, lastObservedState: record.state })),
        },
        overviews,
      }
    )}`;
  }

  /** Explicit, stale-checked handoff; ordinary mutations never adopt a foreign lease. */
  private async takeControl(
    ref: JupyterNotebookReference,
    expectedOwnerId: string,
    expectedGeneration: number,
    signal: AbortSignal
  ): Promise<JupyterControllerGeneration> {
    signal.throwIfAborted();
    this.assertActive();
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      throw new Error('Notebook control requires an exact observed generation');
    }
    const key = resourceKey(ref);
    if (this.leaseFlights.has(key)) {
      throw new Error('Another Notebook control operation is pending');
    }
    const flight = (async () => {
      const state = await this.use(ref, (client) => client.controlState(locator(ref)));
      signal.throwIfAborted();
      this.assertActive();
      if (
        (state.controller?.ownerId ?? '') !== expectedOwnerId ||
        (state.controller?.generation ?? 0) !== expectedGeneration
      ) {
        throw new Error(
          'Notebook control changed; read its current control before requesting transfer'
        );
      }
      if (
        this.records.records().some(
          (record) =>
            resourceKey({
              ...record.target.notebook.identity,
              contentPath: record.target.notebook.contentPath,
            }) === key && !terminal.has(record.state)
        )
      ) {
        throw new Error(
          'Earlier Notebook executions require reconciliation before control transfer'
        );
      }
      const claimed = await this.use(ref, (client) => {
        signal.throwIfAborted();
        this.assertActive();
        return client.claimControl(locator(ref), this.owner, expectedGeneration);
      });
      if (
        claimed.ownerId !== this.owner ||
        claimed.generation < expectedGeneration ||
        (state.controller?.ownerId !== this.owner && claimed.generation === expectedGeneration)
      ) {
        throw new Error('Notebook control response does not match the requested transfer');
      }
      this.records.saveLease(key, claimed);
      signal.throwIfAborted();
      this.assertActive();
      this.boundLeases.add(key);
      return claimed;
    })();
    this.leaseFlights.set(key, flight);
    try {
      return await flight;
    } finally {
      if (this.leaseFlights.get(key) === flight) {
        this.leaseFlights.delete(key);
      }
    }
  }

  private async controller(ref: JupyterNotebookReference): Promise<JupyterControllerGeneration> {
    this.assertActive();
    const key = resourceKey(ref);
    let flight = this.leaseFlights.get(key);
    if (!flight) {
      flight = this.use<JupyterControllerGeneration>(ref, async (client) => {
        const state = await client.controlState(locator(ref));
        const current = state.controller;
        this.assertActive();
        const saved = this.records.lease(key);
        if (saved && sameController(current, saved)) {
          if (!state.paused) {
            this.boundLeases.add(key);
            return saved;
          }
          if (
            this.boundLeases.has(key) ||
            this.records.records().some(
              (record) =>
                resourceKey({
                  ...record.target.notebook.identity,
                  contentPath: record.target.notebook.contentPath,
                }) === key && !terminal.has(record.state)
            )
          ) {
            throw new Error('Notebook stop requires reconciliation before a new execution');
          }
          const resumed = await client.claimControl(locator(ref), this.owner, saved.generation);
          this.records.saveLease(key, resumed);
          this.assertActive();
          this.boundLeases.add(key);
          return resumed;
        }
        if (current || saved) {
          throw new Error('Notebook control changed; no foreign lease is adopted');
        }
        const claimed = await client.claimControl(locator(ref), this.owner, 0);
        this.records.saveLease(key, claimed);
        this.assertActive();
        this.boundLeases.add(key);
        return claimed;
      });
      this.leaseFlights.set(key, flight);
    }
    try {
      return await flight;
    } finally {
      if (this.leaseFlights.get(key) === flight) {
        this.leaseFlights.delete(key);
      }
    }
  }

  private tracked<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    const flight = Promise.resolve().then(() => {
      this.assertActive();
      return operation();
    });
    this.pending.add(flight);
    void flight.finally(() => this.pending.delete(flight)).catch(() => {});
    return flight;
  }

  private binding(ref: JupyterNotebookReference): NotebookToolBinding {
    const notebook = locator(ref);
    return {
      notebook,
      controller: () => this.controller(ref),
      kernel: () =>
        this.use(ref, (client) => {
          this.assertActive();
          return client.ensureKernel(notebook);
        }),
      documents: {
        readCell: (_notebook, cellId) =>
          this.use(ref, (client) => client.readCell(notebook, cellId)),
        editCellSource: (request) =>
          this.tracked(() =>
            this.use(ref, (client) => {
              this.assertActive();
              return client.editCellSource(request);
            })
          ),
      },
      executions: {
        submit: (request) =>
          this.tracked(async () => {
            if (
              this.records.records().some(
                (record) =>
                  resourceKey({
                    ...record.target.notebook.identity,
                    contentPath: record.target.notebook.contentPath,
                  }) === resourceKey(ref) &&
                  (record.state === 'prepared' ||
                    record.state === 'unknown' ||
                    (record.stopRequested && !terminal.has(record.state)))
              )
            ) {
              return {
                state: 'not_started' as const,
                reason: 'An earlier Notebook execution requires reconciliation; no request sent',
              };
            }
            this.records.prepare(request.target);
            let sent = false;
            let result: Awaited<ReturnType<NotebookToolBinding['executions']['submit']>>;
            try {
              result = await this.use(ref, (client) => {
                this.assertActive();
                sent = true;
                return client.submit(request);
              });
            } catch {
              this.records.observe(request.target.runId, sent ? 'unknown' : 'not_started');
              return sent
                ? {
                    state: 'unknown' as const,
                    runId: request.target.runId,
                    reason: 'Submission outcome could not be verified; do not replay',
                  }
                : {
                    state: 'not_started' as const,
                    reason: 'Notebook request stopped before submission',
                  };
            }
            if (result.state === 'accepted') {
              this.records.observe(request.target.runId, 'queued', result.handle);
            } else {
              this.records.observe(request.target.runId, result.state);
            }
            return result;
          }),
        getStatus: (_notebook, runId) =>
          this.use<JupyterExecutionObservation>(ref, async (client) => {
            const result = await client.getStatus(notebook, runId);
            const record = this.records.records().find((r) => r.target.runId === runId);
            if (record) {
              if (
                result.state === 'not_started' &&
                JSON.stringify(handleTarget(result.target)) !==
                  JSON.stringify(handleTarget(record.target))
              ) {
                throw new Error('Unsubmitted execution proof has another recorded target');
              }
              this.records.observe(runId, result.state, result.handle);
            }
            return result;
          }),
        stop: (handle, lease) =>
          this.tracked(() =>
            this.use(ref, (client) => {
              if (
                !this.records
                  .records()
                  .some(
                    (r) =>
                      r.target.runId === handle.runId &&
                      JSON.stringify(handleTarget(r.target)) ===
                        JSON.stringify(handleTarget(handle))
                  )
              ) {
                return Promise.resolve({
                  state: 'ownership_lost' as const,
                  currentGeneration: lease.generation,
                });
              }
              this.assertActive();
              return client.stop(handle, lease);
            })
          ),
      },
    };
  }

  stop(): Promise<NotebookStopObservation[]> {
    this.pause();
    this.stopFlight ??= this.stopOwnedRuns();
    return this.stopFlight;
  }

  private async stopOwnedRuns(): Promise<NotebookStopObservation[]> {
    const deadline = Date.now() + this.stopTimeoutMs;
    this.records.requestStop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.pending]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.min(2_000, this.stopTimeoutMs));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    this.records.requestStop();
    // The server transaction fences late HTTP submissions, not just local callbacks.
    const refs = this.config.listNotebookReferences();
    if (!refs.ok || fs.realpathSync(this.context.currentWorkingDir()) !== this.root) {
      return this.records
        .records()
        .filter((r) => !terminal.has(r.state))
        .map((r) => ({ runId: r.target.runId, state: 'unknown' }));
    }
    const candidates = this.records.records().filter((r) => !terminal.has(r.state));
    const acknowledgments = new Map<string, 'requested' | 'ownership_lost' | 'unknown'>();
    let unavailable = false;
    for (const ref of refs.data) {
      if (!ref.documentId) {
        continue;
      }
      const key = resourceKey(ref);
      const lease = this.records.lease(key);
      if (!lease) {
        continue;
      }
      try {
        const result = await this.use(ref, (client) => client.stopOwner(locator(ref), lease));
        acknowledgments.set(key, result.state);
        if (result.state === 'unknown') {
          unavailable = true;
        }
      } catch {
        acknowledgments.set(key, 'unknown');
        unavailable = true;
      }
    }
    const observations: NotebookStopObservation[] = [];
    for (const record of candidates) {
      const key = resourceKey({
        ...record.target.notebook.identity,
        contentPath: record.target.notebook.contentPath,
      });
      const ref = refs.data.find((r) => r.documentId && resourceKey(r) === key);
      const outcome: NotebookStopObservation = { runId: record.target.runId, state: 'unknown' };
      observations.push(outcome);
      if (acknowledgments.get(key) === 'ownership_lost') {
        outcome.state = 'ownership_lost';
        continue;
      }
      if (!ref || acknowledgments.get(key) !== 'requested' || Date.now() >= deadline) {
        continue;
      }
      try {
        await this.use(ref, async (client) => {
          while (Date.now() < deadline) {
            let status = await client.getStatus(locator(ref), record.target.runId);
            if (status.state === 'unknown' && !status.handle && !record.handle) {
              const reconciled = await client.reconcileSubmission(record.target);
              if (reconciled.state === 'not_started') {
                status = reconciled;
              } else if (reconciled.state === 'recorded') {
                status = reconciled.observation;
              } else {
                if (reconciled.state === 'ownership_lost') {
                  outcome.state = 'ownership_lost';
                }
                return;
              }
            }
            if (status.state === 'not_started') {
              if (
                JSON.stringify(handleTarget(status.target)) !==
                JSON.stringify(handleTarget(record.target))
              ) {
                return;
              }
              this.records.observe(record.target.runId, 'not_started');
              outcome.state = 'already_terminal';
              return;
            }
            if (
              !status.handle ||
              JSON.stringify(handleTarget(status.handle)) !==
                JSON.stringify(handleTarget(record.target))
            ) {
              return;
            }
            if (record.handle && status.handle.requestId !== record.handle.requestId) {
              return;
            }
            this.records.observe(record.target.runId, status.state, status.handle);
            if (terminal.has(status.state)) {
              outcome.state = status.state === 'cancelled' ? 'cancelled' : 'already_terminal';
              return;
            }
            if (status.state === 'unknown') {
              return;
            }
            await wait(100);
          }
        });
      } catch {
        /* Unverified ownership/network outcome remains unknown. */
      }
    }
    if (unavailable && !observations.length) {
      throw new Error('Notebook controller stop could not be verified');
    }
    if (this.pending.size && !observations.length) {
      throw new Error('Notebook callbacks are still settling');
    }
    return observations;
  }
}

export function notebookSessionFactory(
  connections: JupyterConnections
): NotebookAgentSessionFactory {
  return (context) => {
    const config = new JupyterProjectConfigStore(context.workingDir).listNotebookReferences();
    if (!config.ok) {
      throw new Error('Project Notebook references cannot be verified');
    }
    if (!config.data.length) {
      return undefined;
    }
    const backends = new Set(config.data.map((ref) => connections.backend(ref.connectionId)));
    if (backends.size !== 1) {
      throw new Error('A Notebook session requires one backend profile');
    }
    return backends.has('datalayer')
      ? new DatalayerNotebookAgentSession(context, connections)
      : new NotebookAgentSession(context, connections);
  };
}

export async function summarizeNotebookStop(
  session?: NotebookSession
): Promise<NotebookStopSummary> {
  const result: NotebookStopSummary = {
    cancelled: 0,
    alreadyTerminal: 0,
    ownershipLost: 0,
    unknown: 0,
  };
  if (!session) {
    return result;
  }
  try {
    for (const observation of await session.stop()) {
      if (observation.state === 'cancelled') {
        result.cancelled++;
      }
      if (observation.state === 'already_terminal') {
        result.alreadyTerminal++;
      }
      if (observation.state === 'ownership_lost') {
        result.ownershipLost++;
      }
      if (observation.state === 'unknown') {
        result.unknown++;
      }
    }
  } catch {
    result.unavailable = true;
  }
  return result;
}

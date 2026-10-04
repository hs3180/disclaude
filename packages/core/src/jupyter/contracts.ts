/**
 * Shared Jupyter identity, revision, and ownership contracts.
 *
 * These types contain identifiers only. Jupyter URLs and authorization
 * material belong to the separately managed connection layer and must not be
 * copied into Project notebook references or persisted execution records.
 */

/** A configured Jupyter connection paired with its server-side namespace. */
export interface JupyterServiceIdentity {
  /** Opaque ID for the separately configured connection. */
  connectionId: string;
  /** Stable namespace for the Jupyter service behind that connection. */
  serverNamespace: string;
}

/** Stable identity of a Jupyter-managed notebook within one service. */
export interface JupyterNotebookIdentity extends JupyterServiceIdentity {
  /** Server-issued stable document ID. A Contents path alone is not identity. */
  documentId: string;
}

/** Current server path used to locate a notebook with a stable identity. */
export interface JupyterNotebookLocator {
  identity: JupyterNotebookIdentity;
  /** Relative server-side Jupyter Contents path; it may change when the notebook moves. */
  contentPath: string;
}

/** Opaque token for one observed shared-document version. */
export type JupyterDocumentRevision = string;

/** Cell source observed at one live shared-document revision. */
export interface JupyterCellSnapshot {
  notebook: JupyterNotebookLocator;
  /** Stable nbformat cell ID. */
  cellId: string;
  /** Opaque version of the full shared document used for optimistic edits. */
  revision: JupyterDocumentRevision;
  /** Hash of this cell's exact UTF-8 source. */
  sourceHash: string;
  source: string;
}

/**
 * Compare-and-set request for changing one cell's source.
 *
 * Adapters must check the document revision, cell source hash, and controller
 * generation in the same serialized document operation that applies the
 * update. They must not replace the whole notebook as a shortcut.
 */
export interface JupyterCellSourceEditRequest {
  notebook: JupyterNotebookLocator;
  cellId: string;
  expectedRevision: JupyterDocumentRevision;
  expectedSourceHash: string;
  source: string;
  controller: JupyterControllerGeneration;
}

/** Explicit outcomes for a versioned cell-source edit. */
export type JupyterCellSourceEditResult =
  | { state: 'applied'; snapshot: JupyterCellSnapshot }
  | { state: 'conflict'; current: JupyterCellSnapshot }
  | { state: 'ownership_lost'; currentGeneration?: number }
  | { state: 'unknown'; reason: string };

/** Minimum resource operations shared by Jupyter-facing service adapters. */
export interface JupyterNotebookPort {
  readCell(notebook: JupyterNotebookLocator, cellId: string): Promise<JupyterCellSnapshot>;
  editCellSource(request: JupyterCellSourceEditRequest): Promise<JupyterCellSourceEditResult>;
}

/**
 * Current automation ownership for a notebook.
 *
 * Generations are non-negative safe integers that increase whenever control
 * changes. Writes, execution submits, result commits, and stops must check
 * both fields at the operation boundary. An older generation cannot act on
 * work owned by a newer one.
 */
export interface JupyterControllerGeneration {
  ownerId: string;
  generation: number;
}

/** Inputs that identify the source and owner before a kernel request is sent. */
export interface JupyterExecutionTarget {
  notebook: JupyterNotebookLocator;
  cellId: string;
  /** Live document revision checked before execution. */
  expectedRevision: JupyterDocumentRevision;
  /** Hash of the exact source submitted to the kernel; adapters verify it. */
  sourceHash: string;
  /** Kernel identity and incarnation observed for this run. */
  kernelId: string;
  kernelIncarnation: string;
  /** Local stable ID for reconciliation if submission becomes ambiguous. */
  runId: string;
  controller: JupyterControllerGeneration;
}

/** Server request identity attached after Jupyter accepts an execution. */
export interface JupyterExecutionHandle extends JupyterExecutionTarget {
  requestId: string;
}

/** States callers must preserve when reconciling a persistent execution. */
export type JupyterExecutionState =
  | 'queued'
  | 'running'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'stopping'
  | 'cancelled'
  | 'unknown';

/** A local execution attempt is created before the server request is sent. */
export interface JupyterExecutionSubmitRequest {
  target: JupyterExecutionTarget;
  source: string;
}

/** An ambiguous submit stays queryable by run ID and is never replayed blindly. */
export type JupyterExecutionSubmitResult =
  | { state: 'accepted'; handle: JupyterExecutionHandle }
  | { state: 'rejected'; reason: string }
  | { state: 'not_started'; reason: string }
  | { state: 'unknown'; runId: string; reason: string };

/** Durable server proof: this exact attempt cannot enter a kernel later. */
export interface JupyterUnsubmittedExecution {
  runId: string;
  state: 'not_started';
  target: JupyterExecutionTarget;
  submissionFenced: true;
  handle?: never;
}

/** Current server observation for one persisted local execution attempt. */
export type JupyterExecutionObservation =
  | JupyterUnsubmittedExecution
  | {
      runId: string;
      state: 'queued' | 'running' | 'input_required' | 'stopping';
      handle: JupyterExecutionHandle;
    }
  | {
      runId: string;
      state: 'completed' | 'failed' | 'cancelled';
      handle: JupyterExecutionHandle;
      reason?: string;
    }
  | {
      runId: string;
      state: 'unknown';
      handle?: JupyterExecutionHandle;
      reason: string;
    };

/** A stop acknowledgment does not itself prove that the kernel is stopped. */
export type JupyterExecutionStopResult =
  | { state: 'requested' }
  | { state: 'ownership_lost'; currentGeneration?: number }
  | { state: 'not_found' }
  | { state: 'unknown'; reason: string };

/** Minimal shared submit/query/stop boundary for a persistent Jupyter run. */
export interface JupyterExecutionPort {
  submit(request: JupyterExecutionSubmitRequest): Promise<JupyterExecutionSubmitResult>;
  /** Read-only reconciliation is available to a caller that no longer owns the run. */
  getStatus(notebook: JupyterNotebookLocator, runId: string): Promise<JupyterExecutionObservation>;
  /** The caller must pass its current lease; the stored handle lease is not stop authority. */
  stop(
    handle: JupyterExecutionHandle,
    controller: JupyterControllerGeneration
  ): Promise<JupyterExecutionStopResult>;
  /** Reconcile the original submission; persist a fence before claiming it never started. */
  reconcileSubmission?(
    target: JupyterExecutionTarget
  ): Promise<JupyterExecutionReconciliationResult>;
}

/** An absence read alone is insufficient: a late original POST must also be fenced. */
export type JupyterExecutionReconciliationResult =
  | JupyterUnsubmittedExecution
  | { state: 'recorded'; observation: JupyterExecutionObservation }
  | { state: 'ownership_lost'; currentGeneration: number }
  | { state: 'unknown'; runId: string; reason: string };

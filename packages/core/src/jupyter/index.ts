/** Optional remote Notebook transport. Does not initialize the agent SDK/config. */
export { DatalayerJupyterClient } from './datalayer-client.js';
export type {
  DatalayerConnectionInspection,
  DatalayerExecutionHandle,
  DatalayerExecutionObservation,
  DatalayerExecutionPolicy,
  DatalayerObservationFailure,
  JupyterKernelInterruptResult,
} from './datalayer-client.js';
export { JupyterHttpConnection, createJupyterCookieJar } from './http-connection.js';
export type { JupyterHttpOptions } from './http-connection.js';
export { notebookSnapshotHash } from './notebook-fingerprint.js';
export { insertNotebookCell } from './notebook-cell.js';
export { JupyterDiagnosticError, jupyterDiagnostic, jupyterExitCode, jupyterHashConflict,
  jupyterNetworkDiagnostic, jupyterServerBody, redactJupyterText } from './diagnostics.js';
export type { JupyterDiagnostic, JupyterErrorLayer } from './diagnostics.js';

import type { AttemptExit } from './attempt-process.js';

export interface ClaudeAttemptEvidence {
  messages: number;
  partials: boolean;
  permissionRequests: number;
  toolObserved: boolean;
  inputOffered: boolean;
  inputPullPending: boolean;
  processStarted: boolean;
}

/** Positive pre-work proof is required; absence of host output is insufficient. */
export function claudeReplayBlock(evidence: ClaudeAttemptEvidence, exit: AttemptExit): string | undefined {
  if (!exit.confirmed) { return 'process-exit-unconfirmed'; }
  if (evidence.messages) { return 'messages-observed'; }
  if (evidence.partials) { return 'partials-observed'; }
  if (evidence.permissionRequests) { return 'permission-request-observed'; }
  if (evidence.toolObserved) { return 'tool-execution-observed'; }
  if (evidence.inputOffered) { return 'input-delivery-uncertain'; }
  if (evidence.inputPullPending) { return 'input-pull-pending'; }
  // Native startup may execute configured hooks before reading the prompt.
  if (evidence.processStarted) { return 'native-startup-outcome-uncertain'; }
  return undefined;
}

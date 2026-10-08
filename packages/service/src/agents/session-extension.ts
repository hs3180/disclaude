import type { AgentQueryOptions, FileRef } from '@disclaude/core';

/** A file callback captured for the active session, channel and turn. */
export interface AgentFileDelivery {
  sendFile(filePath: string, signal: AbortSignal): Promise<string | void>;
}

export interface AgentSessionContext {
  workingDir: string;
  sessionKey: string;
  currentWorkingDir(): string;
  captureFileDelivery(): AgentFileDelivery | undefined;
}

/** Optional host behavior composed with a query session, independent of its domain. */
export interface AgentSessionExtension {
  readonly inactive: boolean;
  configureQueryOptions?(options: AgentQueryOptions): AgentQueryOptions;
  messageContext?(attachments: readonly FileRef[]): Promise<string>;
  /** Disable new callbacks while retaining external work for later observation. */
  pause(): void;
  /** Release this query's host resources without erasing persistent work. */
  dispose(): void;
}

export type AgentSessionExtensionFactory = (
  context: AgentSessionContext
) => AgentSessionExtension | undefined;

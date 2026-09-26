import { startBrowserCoordinator } from './service.mjs';

export interface BrowserRuntime {
  stop(): Promise<void>;
  /** The coordinator now shares the Disclaude service process. */
  readonly pid: number;
  readonly unavailable: boolean;
}

/** Start the coordinator in this process when the IPC socket is configured. */
export function startBrowserRuntime(
  env: NodeJS.ProcessEnv = process.env,
  onUnavailable: (message: string) => void = () => {},
  onEvent: (record: Record<string, unknown>) => void = () => {},
): Promise<BrowserRuntime | undefined> {
  if (!env.DISCLAUDE_BROWSER_SOCKET) { return Promise.resolve(undefined); }
  return startBrowserCoordinator({ env, onUnavailable, onEvent });
}

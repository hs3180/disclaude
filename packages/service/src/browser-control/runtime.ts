import { hasChromiumCdpConfiguration, startBrowserCoordinator } from './service.mjs';
import { resolveBrowserSocketPath } from '@disclaude/core/browser-runtime';

export interface BrowserRuntime {
  stop(): Promise<void>;
  /** The coordinator now shares the Disclaude service process. */
  readonly pid: number;
  readonly unavailable: boolean;
}

/** Start the coordinator in this process when a deployed Chromium CDP is configured. */
export async function startBrowserRuntime(
  env: NodeJS.ProcessEnv = process.env,
  onUnavailable: (message: string) => void = () => {},
  onEvent: (record: Record<string, unknown>) => void = () => {},
): Promise<BrowserRuntime | undefined> {
  if (!hasChromiumCdpConfiguration(env)) {
    // Ignore legacy/user-provided socket values when the service has no CDP to coordinate.
    if (env === process.env) { delete process.env.DISCLAUDE_BROWSER_SOCKET; }
    return undefined;
  }

  const socketPath = resolveBrowserSocketPath(env);
  const runtime = await startBrowserCoordinator({ env, onUnavailable, onEvent });
  if (env !== process.env) { return runtime; }

  // Internal runtime handoff for agent children; never a configuration input.
  process.env.DISCLAUDE_BROWSER_SOCKET = socketPath;
  return {
    pid: runtime.pid,
    get unavailable() { return runtime.unavailable; },
    async stop() {
      try { await runtime.stop(); }
      finally {
        if (process.env.DISCLAUDE_BROWSER_SOCKET === socketPath) {
          delete process.env.DISCLAUDE_BROWSER_SOCKET;
        }
      }
    },
  };
}

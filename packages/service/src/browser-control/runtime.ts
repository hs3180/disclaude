import { hasChromiumCdpConfiguration, prepareBrowserCommands } from './service.mjs';
import { resolveBrowserRuntimePath } from '@disclaude/core/browser-runtime';

export interface BrowserRuntime {
  stop(): Promise<void>;
  /** The service owns launcher availability; there is no coordinator process. */
  readonly pid: number;
  readonly unavailable: boolean;
}

/** Prepare command coordination for an already deployed Chromium CDP. */
export async function startBrowserRuntime(
  env: NodeJS.ProcessEnv = process.env,
  onEvent: (record: Record<string, unknown>) => void = () => {},
): Promise<BrowserRuntime | undefined> {
  if (!hasChromiumCdpConfiguration(env)) {
    // #5601: a set-but-empty BU_CDP_URL is a configuration mistake, not an
    // opt-out. Keep the ambient runtime pointer so `disclaude browser status`
    // reports the inconsistency (empty BU_CDP_URL treated as unset) instead of
    // silently withdrawing coordination state.
    const emptyCdpUrl = Object.hasOwn(env, 'BU_CDP_URL') && !env.BU_CDP_URL?.trim();
    if (env === process.env && !emptyCdpUrl) { delete process.env.DISCLAUDE_BROWSER_RUNTIME; }
    return undefined;
  }

  const runtimePath = resolveBrowserRuntimePath(env);
  const runtime = await prepareBrowserCommands({ env, onEvent });
  if (env !== process.env) { return runtime; }

  // Internal runtime handoff for agent children; never a configuration input.
  process.env.DISCLAUDE_BROWSER_RUNTIME = runtimePath;
  return {
    pid: runtime.pid,
    get unavailable() { return runtime.unavailable; },
    async stop() {
      try { await runtime.stop(); }
      finally {
        if (process.env.DISCLAUDE_BROWSER_RUNTIME === runtimePath) {
          delete process.env.DISCLAUDE_BROWSER_RUNTIME;
        }
      }
    },
  };
}

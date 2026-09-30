import { hasChromiumCdpConfiguration, prepareBrowserCommands } from './service.mjs';
import { resolveBrowserRuntimePath } from "../../../core/dist/utils/browser-env.js";
/** Prepare command coordination for an already deployed Chromium CDP. */
export async function startBrowserRuntime(env = process.env, onEvent = () => { }) {
    if (!hasChromiumCdpConfiguration(env)) {
        if (env === process.env) {
            delete process.env.DISCLAUDE_BROWSER_RUNTIME;
        }
        return undefined;
    }
    const runtimePath = resolveBrowserRuntimePath(env);
    const runtime = await prepareBrowserCommands({ env, onEvent });
    if (env !== process.env) {
        return runtime;
    }
    // Internal runtime handoff for agent children; never a configuration input.
    process.env.DISCLAUDE_BROWSER_RUNTIME = runtimePath;
    return {
        pid: runtime.pid,
        get unavailable() { return runtime.unavailable; },
        async stop() {
            try {
                await runtime.stop();
            }
            finally {
                if (process.env.DISCLAUDE_BROWSER_RUNTIME === runtimePath) {
                    delete process.env.DISCLAUDE_BROWSER_RUNTIME;
                }
            }
        },
    };
}

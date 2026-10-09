export function hasChromiumCdpConfiguration(env?: NodeJS.ProcessEnv): boolean;
export function processExists(pid: any): boolean;
export function resolveCdpEndpoint(env: any): string;
export function resolveBrowserUse(env: any, launcherDirectory: any): string;
export function readBrowserRuntime(path: any): any;
export function browserStatus(path: any): {
    state: string;
    pid: any;
    executable: any;
};
export function prepareBrowserCommands({ env, fetchImpl, onEvent, }?: {
    env?: NodeJS.ProcessEnv | undefined;
    fetchImpl?: typeof fetch | undefined;
    onEvent?: ((record: Record<string, unknown>) => void) | undefined;
}): Promise<{
    pid: number;
    readonly unavailable: boolean;
    stop(): Promise<void>;
}>;
//# sourceMappingURL=service.d.mts.map
export function hasChromiumCdpConfiguration(env?: NodeJS.ProcessEnv): boolean;
export function processExists(pid: any): boolean;
export function resolveCdpEndpoint(env: any): string;
export function resolveCdpConfiguration(env: any): {
    endpoint: string;
    endpointSource: string;
};
export function resolveBrowserUse(env: any, launcherDirectory: any): string;
export function readBrowserRuntime(path: any): any;
export function browserStatus(path: any): {
    lastDiagnostic?: any;
    state: string;
    pid: any;
    executable: any;
};
export function refreshBrowserRuntimeConnection({ env, fetchImpl, onEvent, tolerateDiscoveryFailure, }?: {
    env?: NodeJS.ProcessEnv | undefined;
    fetchImpl?: typeof fetch | undefined;
    onEvent?: (() => void) | undefined;
    tolerateDiscoveryFailure?: boolean | undefined;
}): Promise<any>;
export function diagnoseBrowserRuntime(env?: NodeJS.ProcessEnv): {
    notes?: string[] | undefined;
    available: boolean;
    state: string;
    runtimePath: string;
    endpoint: string | null;
    endpointSource: string;
    lastError: string;
    remedy: string;
} | {
    notes?: string[] | undefined;
    runtimePath: string;
    endpoint: any;
    endpointSource: string;
    lastError: null;
    remedy: null;
    lastDiagnostic?: any;
    state: string;
    pid: any;
    executable: any;
    available: boolean;
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
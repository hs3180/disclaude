export function connect(url: any, { endpoint, endpointSource, onEvent, observation, timeoutMs, maxPayloadBytes, env }?: {
    endpoint?: any;
    endpointSource?: string | undefined;
    onEvent?: (() => void) | undefined;
    observation?: string | undefined;
    timeoutMs?: number | undefined;
    env?: NodeJS.ProcessEnv | undefined;
}): Promise<{
    ws: any;
    closed: Promise<any>;
    call(method: any, params: {} | undefined, sessionId: any, { timeoutMs: callTimeoutMs }?: {
        timeoutMs?: number | undefined;
    }): Promise<any>;
    close(): Promise<void>;
}>;
//# sourceMappingURL=cdp.d.mts.map
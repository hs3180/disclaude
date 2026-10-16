/** Observe HTTP error responses without intercepting or replaying browser work.
 * This connection lives only for one lock-held invocation. A target may start
 * loading before Network.enable completes; absent request metadata stays unknown.
 */
export function observeBrowser({ websocket, endpoint, endpointSource, onDiagnostic, env }: {
    websocket: any;
    endpoint: any;
    endpointSource: any;
    onDiagnostic: any;
    env?: NodeJS.ProcessEnv | undefined;
}): Promise<{
    stop(): Promise<void>;
}>;
//# sourceMappingURL=observer.d.mts.map
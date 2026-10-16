export function browserDiagnostic({ stage, url, endpoint, endpointSource, method, status, reason, observation, response, env, headers }: {
    stage: any;
    url: any;
    endpoint: any;
    endpointSource?: string | undefined;
    method?: string | undefined;
    status: any;
    reason: any;
    observation?: string | undefined;
    response: any;
    env?: NodeJS.ProcessEnv | undefined;
    headers: any;
}): {
    response: any;
    reason?: any;
    status?: any;
    endpoint: string;
    endpointSource: string;
    url: string;
    path: any;
    type: string;
    stage: any;
    observation: string;
    method: string;
};
export function discoverCdp({ endpoint, endpointSource, fetchImpl, env }: {
    endpoint: any;
    endpointSource: any;
    fetchImpl?: typeof fetch | undefined;
    env?: NodeJS.ProcessEnv | undefined;
}): Promise<{
    websocket: import("url").URL;
    browserId: string;
}>;
export class BrowserDiagnosticError extends Error {
    constructor(diagnostic: any);
    diagnostic: any;
}
export { safeLocation, safeErrorResponse } from "./response-summary.mjs";
//# sourceMappingURL=diagnostics.d.mts.map
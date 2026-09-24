export function connectBrowser(socketPath: any): Promise<{
    request(method: any, args?: {}): Promise<any>;
    close(): void;
}>;
export function main(): Promise<void>;
/** Maintain heartbeats only while owning/executing the segment, not while releasing it. */
export function withBrowserLease(client: any, execute: any, onQueued?: () => void): Promise<void>;
//# sourceMappingURL=client.d.mts.map
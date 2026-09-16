export function connect(url: any): Promise<{
    ws: any;
    closed: Promise<any>;
    call(method: any, params: {} | undefined, sessionId: any): Promise<any>;
    close(): Promise<void>;
}>;
//# sourceMappingURL=cdp.d.mts.map
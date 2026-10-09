export function connect(url: any): Promise<{
    ws: WebSocket;
    closed: Promise<any>;
    call(method: any, params: {} | undefined, sessionId: any): Promise<any>;
    close(): Promise<void>;
}>;
import WebSocket from 'ws';
//# sourceMappingURL=cdp.d.mts.map
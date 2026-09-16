/** Cooperative browser-control coordinator, NOT a production security boundary. */
export class Coordinator {
    constructor({ url, target, event, verifyReclaimed, ttlMs, hardMs, workerModule, workerOptions, detachedWorker, startupMs, cleanupWorker, onTargetChange }: {
        url: any;
        target: any;
        event?: (() => void) | undefined;
        verifyReclaimed?: (() => Promise<void>) | undefined;
        ttlMs?: number | undefined;
        hardMs?: number | undefined;
        workerModule?: import("url").URL | undefined;
        workerOptions?: {} | undefined;
        detachedWorker?: boolean | undefined;
        startupMs?: number | undefined;
        cleanupWorker?: (() => void) | undefined;
        onTargetChange?: (() => void) | undefined;
    });
    boot: `${string}-${string}-${string}-${string}-${string}`;
    epoch: number;
    queue: any[];
    holder: {
        ticket: any;
        actor: any;
        epoch: number;
        token: `${string}-${string}-${string}-${string}-${string}`;
        state: string;
        pending: Map<any, any>;
        serial: Promise<void>;
        seq: number;
    } | null;
    busy: boolean;
    closed: boolean;
    monitor: NodeJS.Timeout;
    log(type: any, fields?: {}): void;
    acquire(actor: any, { waitMs }?: {
        waitMs?: number | undefined;
    }): {
        promise: Promise<any>;
        cancel(): void;
    };
    cancel(ticket: any, reason: any): boolean;
    pump(): Promise<void>;
    target: any;
    validate(lease: any): {
        ticket: any;
        actor: any;
        epoch: number;
        token: `${string}-${string}-${string}-${string}-${string}`;
        state: string;
        pending: Map<any, any>;
        serial: Promise<void>;
        seq: number;
    };
    heartbeat(lease: any): void;
    execute(lease: any, command: any, value: any): Promise<any>;
    release(lease: any): Promise<boolean>;
    revoke(h: any, reason: any): any;
    killWorker(h: any): void;
    inject(lease: any, fault: any): void;
    close(): Promise<void>;
}
//# sourceMappingURL=coordinator.d.mts.map
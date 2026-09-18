/** Probe an explicitly selected executable with disposable state, never a live profile. */
export function diagnoseBrowser({ binary, headless, signal }: {
    binary: any;
    headless?: boolean | undefined;
    signal: any;
}): Promise<{
    executable: string;
    platform: NodeJS.Platform;
    arch: NodeJS.Architecture;
    mode: string;
    usable: boolean;
    cookiePersistence: string;
    profile: string;
    cycles: never[];
}>;
//# sourceMappingURL=doctor.d.mts.map
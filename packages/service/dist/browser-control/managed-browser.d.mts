/** Start only the explicitly configured independent browser/profile. */
export function launchBrowser({ binary, profile, headless, signal }: {
    binary: any;
    profile: any;
    headless?: boolean | undefined;
    signal: any;
}): Promise<{
    endpoint: string;
    child: import("child_process").ChildProcessByStdio<null, null, import("stream").Readable>;
    stop: ({ graceful }?: {
        graceful?: boolean | undefined;
    }) => Promise<void>;
    readonly stderr: string;
}>;
//# sourceMappingURL=managed-browser.d.mts.map
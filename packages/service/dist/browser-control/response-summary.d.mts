/** Values never leave this function's callers; read current environment on each diagnostic. */
export function knownSecrets(env: NodeJS.ProcessEnv | undefined, urls: any[] | undefined, headers: any): (string | undefined)[];
export function redactKnown(value: any, secrets: any): any;
export function safeLocation(value: any, secrets?: any[]): {
    url: string;
    path: any;
};
/** Positive value allowlists: field names alone never authorize arbitrary text. */
export function safeErrorResponse(input: any): {
    body: {
        omittedReason: any;
    };
    mediaType?: any;
    statusText?: any;
};
export function responseBodyEligibility(headers: any): "body-too-large" | "html-response" | "unsupported-media-type" | "encoded-body" | undefined;
/** Bound decoded bytes and the whole read duration; cancellation never delays diagnostics. */
export function readErrorResponse(response: any, context: any): Promise<{
    body: {
        omittedReason: any;
    };
    mediaType?: any;
    statusText?: any;
}>;
export const ERROR_BODY_BYTES: 4096;
export const ERROR_BODY_TIMEOUT_MS: 250;
//# sourceMappingURL=response-summary.d.mts.map
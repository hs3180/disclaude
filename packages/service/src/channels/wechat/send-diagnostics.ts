import { sanitizeDiagnosticText } from '@disclaude/core';

const MESSAGE_TYPES = ['text', 'image', 'file', 'video'] as const;
const STAGES = ['request', 'http-response', 'response-body', 'response-json', 'api-response'] as const;
const FAILURES = ['http-rejected', 'api-rejected', 'timeout', 'aborted', 'transport-error', 'invalid-response'] as const;
const TRANSPORT_CODES = [
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN',
] as const;
const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;

export type WeChatSendMessageType = typeof MESSAGE_TYPES[number];
export type WeChatSendStage = typeof STAGES[number];
export type WeChatSendFailure = typeof FAILURES[number];

/** Observations about one real sendmessage request. Ages describe local observations, never credential validity. */
export interface WeChatSendDiagnostics {
  clientMessageId: string;
  channelId?: string;
  peerHash: string;
  messageType: WeChatSendMessageType;
  replyContextPresent: boolean;
  replyContextObservedAgeMs?: number;
  lastAcceptedPollAgeMs?: number;
  elapsedMs: number;
  stage: WeChatSendStage;
  failure?: WeChatSendFailure;
  transportCode?: typeof TRANSPORT_CODES[number];
  upstreamRequestId?: string;
  upstreamTraceId?: string;
  serverErrorMessagePresent?: boolean;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function duration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function observedAgeMs(observedAt: number | undefined, now: number): number | undefined {
  return observedAt === undefined || duration(observedAt) === undefined ? undefined : duration(now - observedAt);
}

export function safeWeChatChannelId(value: unknown): string | undefined {
  return value === 'wechat' || (typeof value === 'string' && value.startsWith('wechat:') && UUID.test(value.slice(7))) ? value : undefined;
}

/** Accept only recognized correlation-ID formats from named response fields, and drop known credential values. */
export function safeUpstreamId(value: unknown, secrets: readonly string[] = []): string | undefined {
  if (typeof value !== 'string' || (!UUID.test(value) && !/^(?:[a-f\d]{16,64}|\d{8,15})$/i.test(value))) { return undefined; }
  try { return sanitizeDiagnosticText(value, secrets) === value ? value : undefined; }
  catch { return undefined; }
}

/** Fetch/Undici error codes are useful; arbitrary error messages and causes may contain URLs or secrets. */
export function safeTransportCode(error: unknown): WeChatSendDiagnostics['transportCode'] {
  if (!(error instanceof Error)) { return undefined; }
  const source = error as Error & { code?: unknown; cause?: { code?: unknown } };
  if (oneOf(TRANSPORT_CODES, source.code)) { return source.code; }
  return oneOf(TRANSPORT_CODES, source.cause?.code) ? source.cause.code : undefined;
}

/** Rebuild an allowlisted observation at the REST boundary instead of serializing an error's arbitrary properties. */
export function safeSendDiagnostics(value: unknown, secrets: readonly string[] = []): WeChatSendDiagnostics | undefined {
  if (!value || typeof value !== 'object') { return undefined; }
  const data = value as Record<string, unknown>;
  const elapsedMs = duration(data.elapsedMs);
  if (typeof data.clientMessageId !== 'string' || !UUID.test(data.clientMessageId)
    || typeof data.peerHash !== 'string' || !/^[a-f\d]{12}$/.test(data.peerHash)
    || !oneOf(MESSAGE_TYPES, data.messageType) || typeof data.replyContextPresent !== 'boolean'
    || elapsedMs === undefined || !oneOf(STAGES, data.stage)) { return undefined; }

  const replyContextObservedAgeMs = data.replyContextPresent ? duration(data.replyContextObservedAgeMs) : undefined;
  const lastAcceptedPollAgeMs = duration(data.lastAcceptedPollAgeMs);
  const upstreamRequestId = safeUpstreamId(data.upstreamRequestId, secrets);
  const upstreamTraceId = safeUpstreamId(data.upstreamTraceId, secrets);
  const channelId = safeWeChatChannelId(data.channelId);
  return {
    clientMessageId: data.clientMessageId, peerHash: data.peerHash, messageType: data.messageType,
    replyContextPresent: data.replyContextPresent, elapsedMs, stage: data.stage,
    ...(channelId ? { channelId } : {}),
    ...(replyContextObservedAgeMs !== undefined ? { replyContextObservedAgeMs } : {}),
    ...(lastAcceptedPollAgeMs !== undefined ? { lastAcceptedPollAgeMs } : {}),
    ...(oneOf(FAILURES, data.failure) ? { failure: data.failure } : {}),
    ...(oneOf(TRANSPORT_CODES, data.transportCode) ? { transportCode: data.transportCode } : {}),
    ...(upstreamRequestId ? { upstreamRequestId } : {}),
    ...(upstreamTraceId ? { upstreamTraceId } : {}),
    ...(typeof data.serverErrorMessagePresent === 'boolean' ? { serverErrorMessagePresent: data.serverErrorMessagePresent } : {}),
  };
}

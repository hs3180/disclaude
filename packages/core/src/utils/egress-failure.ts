/**
 * Egress-connectivity failure classification (Issue #5409).
 *
 * An external network outage (dead proxy upstreams, broken DNS, RST-ed
 * overseas TLS) surfaces through providers as generic turn failures — the
 * field case was Codex's `workspace routing discovery failed`, emitted when
 * the account-discovery request could not complete before the model was ever
 * called. The failure text alone is the only signal the host has.
 *
 * This matcher recognizes connectivity-class signatures so callers can (a)
 * show a network-path hint instead of the "check model service, credentials
 * and timeouts" advice that does not fit, and (b) skip immediate same-window
 * retries that are guaranteed to hit the same dead egress. It deliberately
 * stays narrow: ambiguous texts (a bare "timed out" can be model latency,
 * "unauthorized" is credentials) must NOT match.
 */

// Socket/transport errno codes and resolver failures, any provider.
const TRANSPORT_ERRNO = /\b(?:ETIMEDOUT|ENETUNREACH|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|EPIPE|EAI_AGAIN|getaddrinfo)\b/i;
// Plain-language network failure phrases, in either word order: "fetch
// failed" / "network error" / "connection refused" / "unable to connect".
const TRANSPORT_WORD = /\b(?:fetch|network|socket|connect|connection|internet|proxy)\b/i;
const TRANSPORT_FAILURE = /\b(?:failed|failure|error|refused|reset|closed|unreachable|unavailable|unable to|cannot|hang up)\b/i;
// TLS-level failures ("TLS handshake failed", "SSL_ERROR_SYSCALL" — the
// separator class bridges the underscore, so no word boundary after tls/ssl).
const TLS_PHRASE = /\b(?:tls|ssl)[\s_-]*(?:handshake|error|failed|failure)/i;
// Codex app-server workspace-routing table: discovery/routing failures are
// pre-model network probes ("unauthorized (401)" is deliberately excluded —
// that is a credentials problem).
const WORKSPACE_ROUTING = /\bworkspace routing\b[^.\n]{0,40}\b(?:failed|timed out|unreachable)\b/i;

const TRANSPORT_PHRASE = new RegExp(
  `${TRANSPORT_WORD.source}[^.\\n]{0,40}${TRANSPORT_FAILURE.source}|${TRANSPORT_FAILURE.source}[^.\\n]{0,40}${TRANSPORT_WORD.source}`,
  'i',
);

/** Whether a provider failure text looks like an egress/connectivity problem. */
export function isEgressConnectivityFailure(text: string): boolean {
  return TRANSPORT_ERRNO.test(text) || TRANSPORT_PHRASE.test(text) || TLS_PHRASE.test(text) || WORKSPACE_ROUTING.test(text);
}

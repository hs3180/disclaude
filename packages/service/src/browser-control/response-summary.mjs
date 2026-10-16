import { STATUS_CODES } from 'node:http';
import { domainToASCII } from 'node:url';

export const ERROR_BODY_BYTES = 4096;
export const ERROR_BODY_TIMEOUT_MS = 250;
const MEDIA = new Set(['application/json', 'application/problem+json', 'text/plain']);
const CODES = new Set(['NOT_FOUND', 'ROUTE_NOT_FOUND', 'ENDPOINT_NOT_FOUND', 'RESOURCE_NOT_FOUND', 'METHOD_NOT_FOUND',
  'UNKNOWN_METHOD', 'INVALID_REQUEST', 'BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE', 'HTTP_404']);
const NUMERIC_CODES = new Set([...Object.keys(STATUS_CODES).map(Number), -32700, -32600, -32601, -32602, -32603]);
const PHRASES = new Set([...Object.values(STATUS_CODES), 'page not found', '404 page not found', 'Method not found', 'Unknown method', 'Invalid request']
  .map(value => value.toLowerCase()));

function header(headers, name) {
  try {
    if (typeof headers?.get === 'function') return headers.get(name) || '';
    const value = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
    return Array.isArray(value) ? value.join(name === 'set-cookie' ? ', ' : '; ') : typeof value === 'string' ? value : '';
  } catch { return ''; }
}

/** Values never leave this function's callers; read current environment on each diagnostic. */
export function knownSecrets(env = process.env, urls = [], headers) {
  // A public-looking variable name may still be an opaque secret mapping.
  const values = Object.values(env || {}).filter(value => typeof value === 'string' && value);
  for (const value of urls) {
    try {
      const url = new URL(value);
      values.push(decodeURIComponent(url.username), decodeURIComponent(url.password), ...url.searchParams.values());
    } catch { /* An invalid URL supplies no authority. */ }
  }
  // Only cookie values are private sources; attributes such as Path=/ must not
  // turn every route delimiter into a credential. Nothing from headers is output.
  for (const cookie of header(headers, 'set-cookie').split(/,\s*(?=[^;,=\s]+=)/u)) {
    const match = /^[^=;]+=("[^"]*"|[^;]*)/u.exec(cookie);
    if (match) values.push(match[1].replace(/^"|"$/gu, ''));
  }
  return [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length);
}

export function redactKnown(value, secrets) {
  let safe = value.replace(/%[\da-f]{2}/giu, part => part.toUpperCase());
  let decoded = safe;
  // Conservative on encoded credentials: never publish an encoded prefix of a
  // known value, regardless of hex case, partial encoding or nested encoding.
  for (let depth = 0; depth < 3 && /%[\dA-F]{2}/u.test(decoded); depth++) {
    try { decoded = decodeURIComponent(decoded); } catch { return '<encoded-value-omitted>'; }
    if (secrets.some(secret => secret.length >= 4 ? decoded.includes(secret) :
      new RegExp(`(^|[\\s/=:"'])${escapeRegExp(secret)}(?=$|[\\s/?&#=:"'])`, 'u').test(decoded))) return '<redacted>';
  }
  if (/%[\dA-F]{2}/iu.test(decoded)) return '<nested-encoding-omitted>';
  for (const secret of secrets) {
    let encoded; try { encoded = encodeURIComponent(secret); } catch { /* Invalid Unicode cannot authorize an echo. */ }
    for (const form of new Set([secret, encoded, JSON.stringify(secret).slice(1, -1),
      Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')])) {
      if (!form || form.includes('\0')) continue;
      if (secret.length >= 4) safe = safe.split(form).join('\0');
      else {
        const escaped = escapeRegExp(form);
        safe = safe.replace(new RegExp(`(^|[\\s/=:"'])${escaped}(?=$|[\\s/?&#=:"'])`, 'gu'), '$1\0');
      }
    }
  }
  return safe.replaceAll('\0', '<redacted>');
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }

export function safeLocation(value, secrets = []) {
  if (!value) return { url: '<unknown>', path: '<unknown>' };
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return { url: '<non-http-url>', path: '<non-http-url>' };
    const path = redactKnown(url.pathname, secrets).replace(/\/(token|secret|password|api[-_]?key|authorization)\/[^/]+/giu, '/$1/<redacted>').slice(0, 2048);
    const host = secrets.some(secret => {
      let ascii = ''; try { ascii = domainToASCII(secret); } catch { /* Not a host label. */ }
      return url.host.toLowerCase().includes(secret.toLowerCase()) || ascii && url.host.toLowerCase().includes(ascii.toLowerCase());
    }) ? '<redacted-host>' : url.host;
    return { url: `${url.protocol}//${host}${path}`, path };
  } catch { return { url: '<invalid-url>', path: '<invalid-url>' }; }
}

function safeMessage(value, { status, url, method, secrets }) {
  if (typeof value !== 'string' || value.length > 1024 || /[\u0000-\u001f\u007f<>]/u.test(value)) return;
  const text = value.trim();
  if (PHRASES.has(text.toLowerCase()) || text.toLowerCase() === `${status} ${STATUS_CODES[status]}`.toLowerCase()) {
    return redactKnown(text, secrets).slice(0, 256);
  }
  // A response cannot introduce a new, potentially secret-bearing route. Only
  // its method/path agreement with the actual failed request grants a template.
  const route = /^(Cannot|No route for) (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/\S+)$/u.exec(text) ||
    /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/\S+) (not found)$/u.exec(text);
  if (!route || !url) return;
  const verb = route[1] === 'Cannot' || route[1] === 'No route for' ? route[2] : route[1];
  const pathname = route[1] === 'Cannot' || route[1] === 'No route for' ? route[3] : route[2];
  try {
    const actual = new URL(url), candidate = new URL(pathname, actual.origin);
    if (candidate.origin !== actual.origin || candidate.pathname !== actual.pathname || verb !== method) return;
    const path = safeLocation(actual.href, secrets).path.slice(0, 384);
    return route[1] === 'Cannot' || route[1] === 'No route for' ? `${route[1]} ${verb} ${path}` : `${verb} ${path} not found`;
  } catch { return; }
}

/** Positive value allowlists: field names alone never authorize arbitrary text. */
export function safeErrorResponse(input) {
  try { return summarize(input); }
  catch { return { body: { omittedReason: 'unsafe-response-summary' } }; }
}

function summarize({ status, statusText, headers, body, omittedReason, url, method = 'GET', env = process.env, endpoint }) {
  const secrets = knownSecrets(env, [url, endpoint], headers);
  const mediaType = header(headers, 'content-type').split(';')[0].trim().toLowerCase();
  const result = { ...(statusText === STATUS_CODES[status] && redactKnown(statusText, secrets) === statusText ? { statusText } : {}),
    ...(MEDIA.has(mediaType) || mediaType === 'text/html' ? { mediaType } : {}), body: { omittedReason: omittedReason || 'body-unavailable' } };
  if (omittedReason || typeof body !== 'string') return result;
  if (Buffer.byteLength(body) > ERROR_BODY_BYTES) { result.body = { omittedReason: 'body-too-large' }; return result; }
  if (!MEDIA.has(mediaType)) { result.body = { omittedReason: mediaType === 'text/html' ? 'html-response' : 'unsupported-media-type' }; return result; }
  if (/^\s*</u.test(body)) { result.body = { omittedReason: 'html-response' }; return result; }
  const context = { status, url, method, secrets };
  if (mediaType === 'text/plain') {
    const message = safeMessage(body, context);
    result.body = message ? { kind: 'http-error-text', fields: { message } } : { omittedReason: 'unrecognized-error-text' };
    return result;
  }
  let parsed;
  try { parsed = JSON.parse(body); } catch { result.body = { omittedReason: 'invalid-json' }; return result; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { result.body = { omittedReason: 'non-object-json' }; return result; }
  const nested = parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error) ? parsed.error : {};
  const fields = {};
  for (const key of ['code', 'type', 'status', 'message', 'reason']) {
    const value = parsed[key] ?? nested[key];
    const numericSecret = typeof value === 'number' && secrets.includes(String(value));
    if (key === 'status' && Number.isInteger(value) && value >= 100 && value <= 599 && !numericSecret) fields[key] = value;
    else if (key === 'code' && NUMERIC_CODES.has(value) && !numericSecret) fields[key] = value;
    else if (['code', 'type'].includes(key) && typeof value === 'string' &&
      (CODES.has(value) || ['not_found', 'route_not_found', 'about:blank'].includes(value))) fields[key] = redactKnown(value, secrets);
    else if (['message', 'reason'].includes(key)) {
      const message = safeMessage(value, context); if (message) fields[key] = message;
    }
  }
  // Fixed count and per-field bounds above keep the entire summary below 1 KiB.
  result.body = Object.keys(fields).length ? { kind: 'json-error', fields } : { omittedReason: 'no-safe-error-fields' };
  if (Buffer.byteLength(JSON.stringify(result.body)) > 1024) result.body = { omittedReason: 'summary-too-large' };
  return result;
}

export function responseBodyEligibility(headers) {
  const type = header(headers, 'content-type').split(';')[0].trim().toLowerCase();
  if (!MEDIA.has(type)) return type === 'text/html' ? 'html-response' : 'unsupported-media-type';
  const encoding = header(headers, 'content-encoding').trim().toLowerCase();
  if (encoding && encoding !== 'identity') return 'encoded-body';
  const length = header(headers, 'content-length');
  if (/^\d+$/u.test(length) && Number(length) > ERROR_BODY_BYTES) return 'body-too-large';
}

/** Bound decoded bytes and the whole read duration; cancellation never delays diagnostics. */
export async function readErrorResponse(response, context) {
  const headers = response.headers, status = response.status ?? response.statusCode, statusText = response.statusText ?? response.statusMessage;
  const source = response.body ?? response;
  let reader, timer;
  const cancel = () => {
    try { const pending = reader?.cancel?.(); pending?.catch?.(() => {}); } catch { /* Already closed/locked. */ }
    if (!reader) { try { source?.cancel?.().catch(() => {}); } catch { /* Already closed/locked. */ } }
    try { response.destroy?.(); } catch { /* Already closed. */ }
  };
  let body, omittedReason = responseBodyEligibility(headers);
  try {
    if (!omittedReason) {
      reader = source?.getReader?.() ?? source?.[Symbol.asyncIterator]?.();
      if (!reader) omittedReason = 'body-unavailable';
      else {
        const read = async () => {
          const chunks = []; let bytes = 0;
          for (;;) {
            const item = await (reader.read ? reader.read() : reader.next());
            if (item.done) return Buffer.concat(chunks).toString('utf8');
            bytes += Buffer.byteLength(item.value);
            if (bytes > ERROR_BODY_BYTES) throw new Error('body-too-large');
            chunks.push(Buffer.from(item.value));
          }
        };
        body = await Promise.race([read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('body-timeout')), ERROR_BODY_TIMEOUT_MS); })]);
      }
    }
  } catch (error) { omittedReason = ['body-too-large', 'body-timeout'].includes(error.message) ? error.message : 'body-read-failed'; }
  finally { clearTimeout(timer); cancel(); }
  return safeErrorResponse({ ...context, status, statusText, headers, body, omittedReason });
}

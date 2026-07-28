#!/usr/bin/env node
/**
 * Card Kit element-update rate-limit characterization bench (#4398, #4208 P1-c).
 *
 * Measures sustained PUT /cards/{cardId}/elements/{elementId}/content throughput
 * (the streaming "typewriter" hot path that StreamingThrottle (#4399) governs)
 * before the Feishu Card Kit API starts rejecting with a non-zero business code.
 * The findings tune #4399's per-session throttle (leading/trailing intervals) from
 * real numbers instead of guesses — #4208 explicitly deferred this ("频控实测").
 *
 * NOTE on "PATCH" in the #4398 title: the issue predates the #4418 correction.
 * Card *content/card* updates are PUT (verified live; only settings/finalize use
 * PATCH). This bench targets the PUT element-content hot path — what the throttle
 * actually paces — so "PATCH/s" below means "element-content PUT/s".
 *
 * Self-contained: no package imports — raw fetch against the live endpoint, so it
 * measures the real API surface, not client overhead. Requires Node 22+ (global
 * fetch) and a valid tenant access token.
 *
 * Setup (one-time): create a throwaway streaming card (e.g. via feishu-channel or
 * the streaming-card-builder) and note its card_id + an element_id to hammer.
 * The bench mutates that element's content rapidly — use a disposable card.
 *
 * Usage:
 *   export LARKSUITE_CLI_TENANT_ACCESS_TOKEN=t-xxx
 *   export CARDKIT_BENCH_CARD_ID=xxxxxx
 *   export CARDKIT_BENCH_ELEMENT_ID=xxxxxx
 *   node scripts/cardkit-rate-limit-bench.mjs              # full bench
 *   node scripts/cardkit-rate-limit-bench.mjs --dry-run    # print config, exit
 *
 * Env (optional unless noted):
 *   LARKSUITE_CLI_TENANT_ACCESS_TOKEN  required (Feishu tenant bearer token)
 *   CARDKIT_BENCH_CARD_ID              required (disposable test card id)
 *   CARDKIT_BENCH_ELEMENT_ID           required (element to update)
 *   CARDKIT_BENCH_BASE_URL             default https://open.feishu.cn
 *   CARDKIT_BENCH_RATES                default "2,5,10,15,20,30" (PUT/s to probe)
 *   CARDKIT_BENCH_SECONDS              default 8 (seconds held at each rate)
 *   CARDKIT_BENCH_SEQUENCE_START       default 1 (monotonic sequence counter start)
 */

const DEFAULT_BASE_URL = 'https://open.feishu.cn';
const CARDKIT_PATH = '/open-apis/cardkit/v1';

const cfg = {
  token: process.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN,
  cardId: process.env.CARDKIT_BENCH_CARD_ID,
  elementId: process.env.CARDKIT_BENCH_ELEMENT_ID,
  baseUrl: (process.env.CARDKIT_BENCH_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
  rates: (process.env.CARDKIT_BENCH_RATES || '2,5,10,15,20,30')
    .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0),
  secondsPerRate: Number(process.env.CARDKIT_BENCH_SECONDS || 8),
  sequenceStart: Number(process.env.CARDKIT_BENCH_SEQUENCE_START || 1),
  dryRun: process.argv.includes('--dry-run'),
};

function required(name, val) {
  if (!val) {
    console.error(`Missing required env: ${name}. See --help / file header for setup.`);
    process.exit(2);
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// One element-content PUT. Returns { ok, code, status, ms, error }.
async function putElementContent(token, baseUrl, cardId, elementId, content, sequence) {
  const url = `${baseUrl}${CARDKIT_PATH}/cards/${encodeURIComponent(cardId)}` +
    `/elements/${encodeURIComponent(elementId)}/content`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ content, sequence, uuid: crypto.randomUUID() }),
    });
    const ms = Date.now() - started;
    let parsed = null;
    try { parsed = await res.json(); } catch { /* empty body */ }
    const code = typeof parsed?.code === 'number' ? parsed.code : undefined;
    // Feishu model: HTTP 200 + code!==0 is a business error (rate-limit, bad
    // sequence, permission, ...). code===0 (or absent on 2xx) is success.
    const ok = res.ok && (code === undefined || code === 0);
    return { ok, code, status: res.status, ms, msg: parsed?.msg ?? parsed?.message };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, error: err?.message ?? String(err) };
  }
}

// Hold `rate` PUT/s for `seconds`. Returns aggregated stats. Stops early once a
// second is dominated by business errors (the rate limit has kicked in).
async function probeRate(rate, seconds) {
  let sequence = cfg.sequenceStart;
  const latencies = [];
  let ok = 0, bizErrors = 0, httpErrors = 0, netErrors = 0;
  const errorCodes = {};
  let firstErrorAtSec = null;

  for (let sec = 1; sec <= seconds; sec += 1) {
    const tStart = Date.now();
    const calls = [];
    for (let i = 0; i < rate; i += 1) {
      calls.push(putElementContent(
        cfg.token, cfg.baseUrl, cfg.cardId, cfg.elementId,
        `bench ${sequence} @ ${rate}/s`, sequence,
      ));
      sequence += 1;
    }
    const results = await Promise.all(calls);
    for (const r of results) {
      if (r.ok) {
        ok += 1; latencies.push(r.ms);
      } else if (r.code !== undefined) {
        bizErrors += 1;
        errorCodes[r.code] = (errorCodes[r.code] || 0) + 1;
        if (firstErrorAtSec === null) firstErrorAtSec = sec;
      } else if (r.status && r.status !== 200) {
        httpErrors += 1; if (firstErrorAtSec === null) firstErrorAtSec = sec;
      } else {
        netErrors += 1; if (firstErrorAtSec === null) firstErrorAtSec = sec;
      }
    }
    const elapsed = Date.now() - tStart;
    // If this second was majority business errors, the limit has engaged — stop.
    const total = results.length;
    if (total > 0 && bizErrors / total > 0.5) break;
    if (elapsed < 1000) await new Promise((r) => setTimeout(r, 1000 - elapsed));
  }

  latencies.sort((a, b) => a - b);
  const attempted = ok + bizErrors + httpErrors + netErrors;
  return {
    rate,
    attempted,
    ok,
    achievedPerSec: Number((ok / seconds).toFixed(1)),
    successPct: attempted ? Number(((ok / attempted) * 100).toFixed(1)) : 0,
    bizErrors, httpErrors, netErrors,
    errorCodes,
    firstErrorAtSec,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    maxMs: latencies.length ? latencies[latencies.length - 1] : 0,
  };
}

function recommend(results) {
  // Highest rate that stayed at >=99% success with no business errors.
  const safe = results.filter((r) => r.bizErrors === 0 && r.successPct >= 99);
  const safestRate = safe.length ? Math.max(...safe.map((r) => r.rate)) : 0;
  if (!safestRate) {
    return 'No rate achieved >=99% success with zero business errors — start the ' +
      'throttle conservatively (e.g. 1 PUT/s) and re-run with finer-grained CARDKIT_BENCH_RATES.';
  }
  // Apply a 0.7x safety margin to the fastest clean rate for the trailing interval.
  const trailingIntervalMs = Math.ceil((1 / safestRate) * 1000 / 0.7);
  return [
    `Fastest clean rate: ${safestRate} PUT/s (>=99% success, 0 business errors).`,
    `Recommended StreamingThrottle (#4399) trailing interval >= ${trailingIntervalMs}ms ` +
      `(1/${safestRate}s with a 0.7x safety margin). Leading burst can be more aggressive ` +
      `but should fall back to this interval once streaming is sustained.`,
  ].join('\n  ');
}

// --- main ---
if (cfg.dryRun) {
  console.log('[dry-run] resolved config:');
  console.log(JSON.stringify({
    baseUrl: cfg.baseUrl,
    cardId: cfg.cardId ? `${cfg.cardId.slice(0, 4)}…` : '(unset)',
    elementId: cfg.elementId ? `${cfg.elementId.slice(0, 4)}…` : '(unset)',
    token: cfg.token ? `${cfg.token.slice(0, 4)}…(${cfg.token.length} chars)` : '(unset)',
    rates: cfg.rates,
    secondsPerRate: cfg.secondsPerRate,
    sequenceStart: cfg.sequenceStart,
  }, null, 2));
  console.log('[dry-run] no API calls made. Re-run without --dry-run to bench.');
  process.exit(0);
}

required('LARKSUITE_CLI_TENANT_ACCESS_TOKEN', cfg.token);
required('CARDKIT_BENCH_CARD_ID', cfg.cardId);
required('CARDKIT_BENCH_ELEMENT_ID', cfg.elementId);

console.log(`# Card Kit element-content PUT rate-limit bench (#4398)`);
console.log(`base=${cfg.baseUrl} card=${cfg.cardId} element=${cfg.elementId}`);
console.log(`probing rates ${cfg.rates.join(', ')} PUT/s, ${cfg.secondsPerRate}s each\n`);

const results = [];
for (const rate of cfg.rates) {
  process.stdout.write(`@ ${rate} PUT/s ... `);
  const r = await probeRate(rate, cfg.secondsPerRate);
  results.push(r);
  console.log(
    `ok=${r.ok}/${r.attempted} (${r.successPct}%) achieved=${r.achievedPerSec}/s ` +
    `biz=${r.bizErrors} http=${r.httpErrors} net=${r.netErrors} ` +
    `p50=${r.p50Ms}ms p95=${r.p95Ms}ms firstErrSec=${r.firstErrorAtSec}`
  );
  const codes = Object.entries(r.errorCodes);
  if (codes.length) console.log(`    business codes: ${codes.map(([c, n]) => `${c}×${n}`).join(', ')}`);
}

console.log('\n## Recommendation');
console.log('  ' + recommend(results));
console.log('\n(Attach this output to #4398 / #4399 as the measured throttle basis.)');

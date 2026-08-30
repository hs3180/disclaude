#!/usr/bin/env node
/**
 * Card Kit streaming-update rate-limit characterization bench — CLI (#4398 / #4208 P1-c).
 *
 * Standalone entry point for the bench implemented in
 * `packages/primary-node/src/platforms/feishu/feishu-cardkit-rate-limit-bench.ts`.
 * Runs the sustained-rate sweep → 429 capture → burst test against a LIVE
 * streaming card and prints the findings table that feeds the `StreamingThrottle`
 * defaults (#4414).
 *
 * Run with:
 *   npx tsx scripts/feishu-cardkit-rate-limit-bench.mts
 *
 * Preconditions (the methodology doc, `docs/feishu-cardkit-rate-limit-methodology.md`,
 * spells these out — they cannot be met from CI, only from an operator shell with a
 * live Feishu tenant):
 *   - LARKSUITE_CLI_TENANT_ACCESS_TOKEN  — a valid tenant_access_token with
 *                                          `cardkit:card:write` open on the app.
 *   - CARDKIT_BENCH_CARD_ID              — id of a streaming card
 *                                          (config.streaming_mode = true, JSON-2.0).
 *   - CARDKIT_BENCH_ELEMENT_ID           — the stable element id to PUT
 *                                          (e.g. STREAMING_REPLY_ELEMENT_ID from #4396),
 *                                          already sent to a chat so updates render.
 *
 * Optional overrides (cadences, durations, burst) via CARDKIT_BENCH_* env vars;
 * defaults live in DEFAULT_BENCH_CONFIG.
 */

import {
  createFeishuBenchCaller,
  runRateLimitBench,
  formatFindingsTable,
  DEFAULT_BENCH_CONFIG,
  type BenchConfig,
} from '../packages/primary-node/src/platforms/feishu/feishu-cardkit-rate-limit-bench.js';

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    console.error(
      '\nPreconditions (see docs/feishu-cardkit-rate-limit-methodology.md):\n' +
        '  LARKSUITE_CLI_TENANT_ACCESS_TOKEN  valid tenant token, cardkit:card:write enabled\n' +
        '  CARDKIT_BENCH_CARD_ID              id of a streaming card (streaming_mode=true)\n' +
        '  CARDKIT_BENCH_ELEMENT_ID           stable element id already sent to a chat\n'
    );
    process.exit(1);
  }
  return v;
}

function parseIntList(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length ? parsed : fallback;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function buildConfig(): BenchConfig {
  return {
    cadencesPerSec: parseIntList('CARDKIT_BENCH_CADENCES', DEFAULT_BENCH_CONFIG.cadencesPerSec),
    cadenceDurationMs: parseIntEnv(
      'CARDKIT_BENCH_CADENCE_DURATION_MS',
      DEFAULT_BENCH_CONFIG.cadenceDurationMs
    ),
    probeIntervalMs: parseIntEnv(
      'CARDKIT_BENCH_PROBE_INTERVAL_MS',
      DEFAULT_BENCH_CONFIG.probeIntervalMs
    ),
    probeBudgetMs: parseIntEnv(
      'CARDKIT_BENCH_PROBE_BUDGET_MS',
      DEFAULT_BENCH_CONFIG.probeBudgetMs
    ),
    burst: {
      count: parseIntEnv('CARDKIT_BENCH_BURST_COUNT', DEFAULT_BENCH_CONFIG.burst.count),
      windowMs: parseIntEnv('CARDKIT_BENCH_BURST_WINDOW_MS', DEFAULT_BENCH_CONFIG.burst.windowMs),
      rounds: parseIntEnv('CARDKIT_BENCH_BURST_ROUNDS', DEFAULT_BENCH_CONFIG.burst.rounds),
      idleMs: parseIntEnv('CARDKIT_BENCH_BURST_IDLE_MS', DEFAULT_BENCH_CONFIG.burst.idleMs),
    },
  };
}

async function main(): Promise<void> {
  const tenantAccessToken = requiredEnv('LARKSUITE_CLI_TENANT_ACCESS_TOKEN');
  const cardId = requiredEnv('CARDKIT_BENCH_CARD_ID');
  const elementId = requiredEnv('CARDKIT_BENCH_ELEMENT_ID');
  const baseUrl = process.env.CARDKIT_BENCH_BASE_URL; // optional; defaults to open.feishu.cn
  const config = buildConfig();

  console.error(
    `Card Kit rate-limit bench: card=${cardId} element=${elementId} ` +
      `cadences=[${config.cadencesPerSec.join(',')}] burst=${config.burst.count}×${config.burst.rounds}`
  );

  const caller = createFeishuBenchCaller({ tenantAccessToken, cardId, elementId, baseUrl });
  const result = await runRateLimitBench({ caller, config });

  console.log(formatFindingsTable(result));
  console.error(
    `\nDone. maxSustained=${result.maxSustainedPerSec}/s ` +
      `minIntervalMs=${result.suggestedMinIntervalMs || '—'} ` +
      `maxBackoffMs=${result.suggestedMaxBackoffMs}`
  );
}

main().catch((err: unknown) => {
  console.error('Card Kit rate-limit bench failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

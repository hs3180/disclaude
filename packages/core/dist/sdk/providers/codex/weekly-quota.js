/**
 * Codex weekly-quota ledger + fresh-session admission (#5607, rework 1).
 *
 * Data basis: the codex CLI's own structured rate-limit readings. Per plan
 * window both transports carry the same `RateLimitWindow` numbers, but with
 * version-dependent field-name conventions (#5734): the exec transport's
 * `token_count` JSONL event (field `rate_limits`, binary-proven on 0.151.0)
 * uses snake_case `{ used_percent, window_minutes, resets_at }`, while the
 * app-server `account/rateLimits/updated` / `thread/tokenUsage/updated`
 * notifications on 0.167 use camelCase
 * `{ usedPercent, windowDurationMins, resetsAt }`. The extractor accepts
 * both per field and normalizes them into one ledger window; both channels
 * are already owned by this repo's adapters.
 * No token-budget estimation is involved: every gated number is a REAL
 * upstream reading, only its freshness is process-local.
 *
 * Admission rule (fresh sessions ONLY — a resumed turn and a running turn
 * are never killed or delayed; capacity-recovery retries reuse a thread
 * and are structurally never gated):
 *
 *   block when quota usage progress > weekly-window time progress, where
 *   usage progress = used_percent / 100 and
 *   time progress   = 1 - (resets_at - now) / (window_minutes * 60s)
 *
 * Burning quota faster than the window elapses means the window WILL be
 * exhausted before it resets; burning slower means it will not. A reading
 * without `resets_at` (or a rolled window) cannot compute time progress
 * and never blocks — insufficient data fails open, and the observe-only
 * default (never blocking on readings) keeps the feature dark until
 * `weeklyQuotaAdmission: enforce` is set per deployment.
 *
 * Real usage-limit failures still latch a hard block until their parsed
 * `try again at/in …` deadline (works in observe mode too — that is
 * upstream evidence, not a projection).
 */
export const DEFAULT_WEEKLY_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
/**
 * A window of at least this many minutes is treated as the weekly-class
 * window (7d = 10080; the 5h rolling window is 300 and never gates).
 * Plans may name other windows — only ≥24h windows can gate admission.
 */
export const WEEKLY_WINDOW_MIN_MINUTES = 24 * 60;
/**
 * Parse an upstream reset hint into an epoch-ms deadline. Two shapes,
 * captured from codex output (#4632): absolute "try again at Apr 30th,
 * 2026 11:21 AM" (ordinal suffixes stripped — Date.parse chokes on
 * "30th") and relative "try again in 2.5 hours". Returns undefined when
 * the text carries no usable hint.
 */
export function parseCodexResetHint(text, now) {
    const absolute = /try again (?:at|by)\s+([^.\n]+)/i.exec(text)?.[1];
    if (absolute) {
        const normalized = absolute.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
        const parsed = Date.parse(normalized.includes('T') ? normalized : normalized.replace(/\s+/, ' '));
        if (Number.isFinite(parsed) && parsed > now) {
            return { deadline: parsed, source: 'parsed' };
        }
    }
    // Relative capture must NOT stop at "." — upstream durations carry
    // decimals ("in 2.5 hours"); the duration tokenizer picks its own tokens.
    const relative = /try again in\s+([^\n]+)/i.exec(text)?.[1];
    if (relative) {
        let ms = 0;
        let matched = false;
        for (const match of relative.matchAll(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)/gi)) {
            const value = Number.parseFloat(match[1]);
            if (!Number.isFinite(value)) {
                continue;
            }
            const unit = match[2].toLowerCase();
            const scale = unit.startsWith('week') ? 7 * 24 * 3600_000
                : unit.startsWith('day') ? 24 * 3600_000
                    : unit.startsWith('hour') || unit.startsWith('hr') ? 3600_000
                        : unit.startsWith('min') ? 60_000 : 1000;
            ms += value * scale;
            matched = true;
        }
        if (matched && ms > 0) {
            return { deadline: now + ms, source: 'parsed' };
        }
    }
    return undefined;
}
/** Distinguish the plan's rolling windows from the failure text when possible. */
export function classifyCodexLimitWindow(text) {
    if (/\bweek/i.test(text)) {
        return 'weekly';
    }
    if (/\b(?:5[-\s]?h(?:ou)?rs?|five[-\s]?hours?)\b/i.test(text) || /\blimit[^.\n]{0,80}\bhour/i.test(text)) {
        return 'five-hour';
    }
    return 'unknown';
}
/**
 * Normalize a `resets_at` value to epoch ms. Accepts epoch seconds, epoch
 * milliseconds and parseable timestamp strings; anything else (or the past
 * by more than a minute of clock skew) yields undefined.
 */
function parseResetsAt(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        // Heuristic split: codex timestamps are second-granularity; ms values
        // are 13+ digits. Both accepted so a unit change upstream keeps parsing.
        return value > 1e12 ? value : value * 1000;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^\d+$/.test(trimmed)) {
            return parseResetsAt(Number(trimmed));
        }
        const parsed = Date.parse(trimmed);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return undefined;
}
function toPercent(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return undefined;
    }
    return Math.min(100, value);
}
/**
 * Recursively collect window readings from an arbitrary payload. Two
 * field-name conventions are accepted per field — exec JSONL snake_case
 * `{used_percent, window_minutes[, resets_at]}` (0.151 binary-proven) and
 * app-server camelCase `{usedPercent, windowDurationMins[, resetsAt]}`
 * (#5734, codex 0.167) — normalized into the same reading. The shapes are
 * `rate_limits: {primary, secondary}` (either window may be null) and
 * `rate_limits` (token_count event), but the nesting is version-dependent,
 * so any object carrying BOTH a used-share and a window-span number at any
 * depth (bounded) counts, in either convention. Extra unknown siblings are
 * ignored.
 */
export function extractCodexRateLimitReadings(payload, source, now) {
    const readings = [];
    const visit = (value, depth) => {
        if (readings.length >= 8 || depth > 4) {
            return;
        }
        if (Array.isArray(value)) {
            for (const entry of value) {
                visit(entry, depth + 1);
            }
            return;
        }
        if (typeof value !== 'object' || value === null) {
            return;
        }
        const record = value;
        // Per-field convention fallback (#5734): snake_case first (binary-proven
        // exec shape), then the app-server 0.167 camelCase spelling. A window
        // record never carries the same field in both conventions; if one ever
        // did, snake_case wins as the shape the ledger was built against.
        const usedPercent = toPercent(record.used_percent !== undefined ? record.used_percent : record.usedPercent);
        const rawWindowMinutes = record.window_minutes !== undefined ? record.window_minutes : record.windowDurationMins;
        const windowMinutes = typeof rawWindowMinutes === 'number' && Number.isFinite(rawWindowMinutes) && rawWindowMinutes > 0
            ? rawWindowMinutes
            : undefined;
        if (usedPercent !== undefined && windowMinutes !== undefined) {
            const resetsAt = parseResetsAt(record.resets_at !== undefined ? record.resets_at : record.resetsAt);
            readings.push({
                usedPercent,
                windowMinutes,
                ...(resetsAt !== undefined ? { resetsAt } : {}),
                observedAt: now,
                source,
            });
        }
        for (const child of Object.values(record)) {
            visit(child, depth + 1);
        }
    };
    visit(payload, 0);
    return readings;
}
const WINDOW_LABEL = {
    weekly: '周',
    'five-hour': '5 小时',
    unknown: '周期',
};
function formatPercent(ratio) {
    return `${Math.round(ratio * 100)}%`;
}
function formatTime(epochMs) {
    return new Date(epochMs).toISOString();
}
/**
 * Quota usage progress vs weekly-window time progress. `undefined` when
 * the reading cannot support the comparison (no reset time — or a window
 * that has already rolled, which callers treat as expired).
 */
export function weeklyProgress(reading, now) {
    if (reading.resetsAt === undefined || now >= reading.resetsAt) {
        return undefined;
    }
    const windowMs = reading.windowMinutes * 60_000;
    const timeProgress = Math.min(1, Math.max(0, 1 - (reading.resetsAt - now) / windowMs));
    return { usageProgress: reading.usedPercent / 100, timeProgress };
}
export class CodexWeeklyQuotaLedger {
    admission;
    limitCooldownMs;
    now;
    weeklyReading;
    shortWindowReading;
    limit;
    lastBlock;
    constructor(config = {}, now = Date.now) {
        this.admission = config.weeklyQuotaAdmission === 'enforce' ? 'enforce' : 'observe';
        this.limitCooldownMs = config.weeklyLimitCooldownMs ?? DEFAULT_WEEKLY_LIMIT_COOLDOWN_MS;
        this.now = now;
    }
    get enforcementEnabled() {
        return this.admission === 'enforce';
    }
    /**
     * Record upstream rate-limit windows observed on any transport. The
     * weekly-class reading (largest window ≥ 24h) drives admission; the
     * largest sub-daily window is kept for /status context. A newer
     * observation of the same window always wins.
     */
    recordRateLimits(payload, source) {
        const now = this.now();
        for (const reading of extractCodexRateLimitReadings(payload, source, now)) {
            const isWeeklyClass = reading.windowMinutes >= WEEKLY_WINDOW_MIN_MINUTES;
            const current = isWeeklyClass ? this.weeklyReading : this.shortWindowReading;
            const sameWindow = current !== undefined && current.windowMinutes === reading.windowMinutes;
            // Larger window wins within a class; equal windows keep the latest
            // observation (upstream re-emits as usage grows within the window).
            if (current === undefined || reading.windowMinutes >= current.windowMinutes || sameWindow) {
                if (isWeeklyClass) {
                    this.weeklyReading = reading;
                }
                else {
                    this.shortWindowReading = reading;
                }
            }
        }
    }
    /**
     * Calibrate from a real usage-limit failure. Latches an admission gate
     * until the parsed (or conservative) reset deadline. Independent of the
     * readings path: a failure text proves exhaustion even when no
     * structured window event was observed.
     */
    recordLimitHit(failureText) {
        const now = this.now();
        const parsed = parseCodexResetHint(failureText, now);
        const window = classifyCodexLimitWindow(failureText);
        const until = parsed?.deadline ?? now + this.limitCooldownMs;
        if (!this.limit || until > this.limit.until) {
            this.limit = { until, window, ...(parsed ? { resetAt: parsed.deadline } : {}), source: parsed ? 'parsed' : 'conservative' };
        }
        else {
            // Keep the furthest deadline but refine the window label if the new
            // text is more specific.
            this.limit = { ...this.limit, window: this.limit.window === 'unknown' ? window : this.limit.window };
        }
    }
    /** Lazy expiry before any decision/read: latch and rolled windows. */
    settle(now) {
        if (this.limit && now >= this.limit.until) {
            this.limit = undefined;
        }
        if (this.weeklyReading?.resetsAt !== undefined && now >= this.weeklyReading.resetsAt) {
            // The observed window rolled — its used_percent no longer describes
            // the current window. Drop it until a fresh reading arrives.
            this.weeklyReading = undefined;
        }
        if (this.shortWindowReading?.resetsAt !== undefined && now >= this.shortWindowReading.resetsAt) {
            this.shortWindowReading = undefined;
        }
    }
    /**
     * Admission for a NEW codex conversation (fresh thread). Never called
     * for resumed turns or capacity-recovery retries — running work is
     * untouchable by design, and retries reuse the thread.
     */
    checkFreshSession() {
        const now = this.now();
        this.settle(now);
        if (this.limit) {
            const resetAt = this.limit.resetAt ?? this.limit.until;
            const reason = `Codex ${WINDOW_LABEL[this.limit.window]}额度已用尽（上游撞限实证${this.limit.source === 'conservative' ? '；未解析到重置时刻，按保守冷却估计' : ''}），` +
                `预计 ${formatTime(resetAt)} 重置，此前新会话暂缓。运行中的回合不受影响；窗口重置后重发消息即可恢复。` +
                '如已配置其它 agentBackend，可临时切换使用。';
            this.lastBlock = { at: now, reason };
            return { decision: 'block', resetAt, reason };
        }
        if (this.admission !== 'enforce') {
            return { decision: 'allow' };
        }
        const progress = this.weeklyReading === undefined ? undefined : weeklyProgress(this.weeklyReading, now);
        if (progress === undefined) {
            // No weekly reading, or the reading carries no reset time, or the
            // window already rolled: the comparison is not computable — allow.
            return { decision: 'allow' };
        }
        if (progress.usageProgress > progress.timeProgress) {
            const resetAt = this.weeklyReading?.resetsAt;
            const reason = `Codex 周额度消耗进度已超时间进度：已用 ${formatPercent(progress.usageProgress)}，` +
                `本窗口时间仅过 ${formatPercent(progress.timeProgress)}（上游实测 ${Math.round(this.weeklyReading?.windowMinutes ?? 0)} 分钟窗口读数，` +
                `预计 ${resetAt === undefined ? '' : `${formatTime(resetAt)} `}重置）。为避免窗口末段撞限，新会话暂缓；` +
                '运行中的回合与续聊不受影响；消耗进度回落到时间进度之下或窗口重置后重发消息即可恢复。如已配置其它 agentBackend，可临时切换使用。';
            this.lastBlock = { at: now, reason };
            return { decision: 'block', ...(resetAt !== undefined ? { resetAt } : {}), reason };
        }
        return { decision: 'allow' };
    }
    snapshot() {
        const now = this.now();
        this.settle(now);
        const snapshot = {
            admission: this.admission,
            verdict: this.computeVerdict(now),
            limitLatched: this.limit !== undefined,
        };
        if (this.weeklyReading !== undefined) {
            snapshot.weeklyReading = { ...this.weeklyReading };
            const progress = weeklyProgress(this.weeklyReading, now);
            if (progress) {
                snapshot.usageProgress = progress.usageProgress;
                snapshot.timeProgress = progress.timeProgress;
            }
        }
        if (this.shortWindowReading !== undefined) {
            snapshot.shortWindowReading = { ...this.shortWindowReading };
        }
        if (this.limit) {
            snapshot.limitWindow = this.limit.window;
            snapshot.limitResetAt = this.limit.resetAt ?? this.limit.until;
            snapshot.limitSource = this.limit.source;
        }
        if (this.lastBlock) {
            snapshot.lastBlock = { ...this.lastBlock };
        }
        return snapshot;
    }
    /** Would-decision from current facts — mode-independent (observe reports it). */
    computeVerdict(now) {
        if (this.limit) {
            return 'block';
        }
        if (this.weeklyReading === undefined) {
            return 'insufficient-data';
        }
        const progress = weeklyProgress(this.weeklyReading, now);
        if (progress === undefined) {
            return 'insufficient-data';
        }
        return progress.usageProgress > progress.timeProgress ? 'block' : 'allow';
    }
    /** Human-readable /status lines. Upstream readings, process-local freshness. */
    formatStatusLines() {
        const snapshot = this.snapshot();
        const lines = [];
        if (snapshot.weeklyReading !== undefined && snapshot.usageProgress !== undefined && snapshot.timeProgress !== undefined) {
            const reset = snapshot.weeklyReading.resetsAt;
            lines.push(`🪙 Codex 周额度（上游实测）：已用 ${formatPercent(snapshot.usageProgress)}，` +
                `窗口时间已过 ${formatPercent(snapshot.timeProgress)}` +
                `${reset === undefined ? '' : `，预计 ${formatTime(reset)} 重置`}` +
                `——读数来自 ${snapshot.weeklyReading.source}（本进程最近一次观测）`);
        }
        else {
            lines.push('🪙 Codex 周额度：尚未观测到上游窗口读数（等待 token_count / rateLimits 事件）');
        }
        if (snapshot.shortWindowReading !== undefined) {
            lines.push(`🪙 Codex 短窗口（参考）：已用 ${Math.round(snapshot.shortWindowReading.usedPercent)}%` +
                `（${Math.round(snapshot.shortWindowReading.windowMinutes)} 分钟窗口，来自 ${snapshot.shortWindowReading.source}）`);
        }
        if (snapshot.limitLatched && snapshot.limitResetAt !== undefined) {
            lines.push(`⛔ 撞限实证：上游${snapshot.limitWindow === 'weekly' ? '周' : snapshot.limitWindow === 'five-hour' ? '5 小时' : '周期'}额度已用尽` +
                `（${snapshot.limitSource === 'conservative' ? '未解析到重置时刻，按保守冷却' : '按上游重置提示'}），` +
                `预计 ${formatTime(snapshot.limitResetAt)} 重置——重置前新会话准入受限`);
        }
        const mode = snapshot.admission === 'enforce'
            ? snapshot.verdict === 'block'
                ? '当前判定：拦截新会话'
                : snapshot.verdict === 'allow'
                    ? '当前判定：放行新会话'
                    : '当前判定：数据不足，放行'
            : '观测模式（agent.codex.weeklyQuotaAdmission 未设为 enforce，仅记录不拦截）';
        lines.push(`⚖️ 新会话准入：${mode}${snapshot.admission === 'observe' && snapshot.verdict === 'block' ? '；按当前读数若启用 enforce 将拦截' : ''}`);
        if (snapshot.lastBlock) {
            lines.push(`⛔ 最近一次拦截：${formatTime(snapshot.lastBlock.at)} —— ${snapshot.lastBlock.reason}`);
        }
        return lines;
    }
}

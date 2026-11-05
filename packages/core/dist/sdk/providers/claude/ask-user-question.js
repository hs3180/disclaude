/**
 * AskUserQuestion bridge for chat agents (Issue #5613 / T-057).
 *
 * The claude backend historically hard-disallows the built-in
 * `AskUserQuestion` tool (see disallowed-tools.ts): with no interactive
 * terminal there is nobody to answer the picker. When the host DOES provide
 * an input channel (`AgentQueryOptions.onUserInput`, wired by ChatAgent to
 * the channel's `requestAgentInput`, e.g. Feishu's interactive input card),
 * the tool becomes useful again — this module bridges the SDK's permission
 * surface to that channel.
 *
 * Mechanism: with a `canUseTool` callback attached, the SDK surfaces
 * permission-ask decisions (AskUserQuestion included) as `can_use_tool`
 * control requests. We map the tool input to an `AgentInputRequest`
 * (kind 'rpc', same contract the codex backend rides) and hand it to
 * `onUserInput`. The channel delivers the card and calls `respond()` with
 * the user's answers; we return them to the model as a `deny` permission
 * result whose message IS the answer — the deny branch is the only
 * contract-complete way to hand text back without executing the tool's own
 * interactive picker, which has no headless form.
 *
 * Fail-closed everywhere: without an input context, on malformed input, on
 * delivery failure, on timeout, the tool call is denied with a bounded,
 * model-legible message and the turn continues. Non-AskUserQuestion tools
 * that reach this callback are denied as "no approval surface", preserving
 * the pre-bridge behavior where ask-path decisions were terminal
 * (sdk.d.ts: without canUseTool, "'ask' decisions are terminal").
 *
 * @module sdk/providers/claude/ask-user-question
 */
import { validateAgentInputAnswers, } from '../../user-input.js';
/** Bounded wait for the user's answer; matches the codex transport default. */
export const ASK_USER_QUESTION_TIMEOUT_MS = 15 * 60_000;
const DENY_NO_CONTEXT = 'This conversation cannot receive interactive questions; ask the user directly in your reply text instead.';
const DENY_MALFORMED = 'The AskUserQuestion request was malformed and could not be presented to the user.';
const DENY_NO_SURFACE = 'This session has no interactive approval surface for this tool.';
const DENY_DELIVERY = 'Your question could not be delivered to the user; ask them directly in your reply text instead.';
const DENY_TIMEOUT = 'The user did not answer your question within the time limit.';
const DENY_CANCELLED = 'Your question was cancelled before the user answered.';
/** Bounded string check aligned with the channel-side user-input limits. */
function bounded(value, max, empty = false) {
    return typeof value === 'string' && value.length <= max && (empty || value.trim())
        ? value
        : undefined;
}
/**
 * Map an `AskUserQuestionInput.questions` array to channel questions.
 * Returns `undefined` when the shape is not presentable (fail-closed deny).
 *
 * Upstream guarantees 1-4 questions with 2-4 options each and says the UI
 * adds an "Other" choice automatically — `isOther: true` mirrors that; free
 * text then wins over the picked option on the card, and multi-select
 * questions (no card-side multi-picker) degrade to comma-separated text.
 */
export function parseAskUserQuestions(input) {
    const { questions } = input;
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) {
        return undefined;
    }
    const mapped = [];
    for (const [index, raw] of questions.entries()) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return undefined;
        }
        const q = raw;
        const question = bounded(q.question, 6_000);
        const header = bounded(q.header, 300, true);
        if (question === undefined || header === undefined) {
            return undefined;
        }
        if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
            return undefined;
        }
        const options = [];
        for (const option of q.options) {
            if (!option || typeof option !== 'object' || Array.isArray(option)) {
                return undefined;
            }
            const o = option;
            const label = bounded(o.label, 300);
            const description = bounded(o.description, 2_000, true) ?? '';
            if (label === undefined) {
                return undefined;
            }
            options.push({ label, description });
        }
        if (new Set(options.map(o => o.label)).size !== options.length) {
            return undefined;
        }
        mapped.push({
            id: `q${index + 1}`,
            header,
            question,
            isOther: true,
            isSecret: false,
            options,
        });
    }
    return mapped;
}
/** Format validated answers as the model-facing tool result. */
export function formatAgentInputAnswers(questions, answers) {
    const lines = questions.map(q => {
        const values = answers[q.id]?.answers ?? [];
        return `- ${q.question} → ${values.join(', ')}`;
    });
    return `The user answered your questions:\n${lines.join('\n')}`;
}
/**
 * Build the `canUseTool` callback that bridges AskUserQuestion to the host
 * input channel. Attached only when `onUserInput` is configured (see
 * options-adapter.ts); without it the tool stays disallowed and this
 * callback is never created.
 */
export function createAskUserQuestionPermission(options) {
    const { onUserInput, inputContext, sessionKey, queryId } = options;
    return async (toolName, input, toolOptions) => {
        if (toolName !== 'AskUserQuestion') {
            // Preserves the pre-bridge semantics: ask-path decisions without an
            // approval surface are denied, never silently allowed.
            return { behavior: 'deny', message: DENY_NO_SURFACE };
        }
        const questions = parseAskUserQuestions(input);
        if (!questions) {
            return { behavior: 'deny', message: DENY_MALFORMED };
        }
        const context = inputContext();
        if (!context) {
            return { behavior: 'deny', message: DENY_NO_CONTEXT };
        }
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort('expired'), options.timeoutMs ?? ASK_USER_QUESTION_TIMEOUT_MS);
        const cancel = () => abort.abort(toolOptions.signal.reason);
        toolOptions.signal.addEventListener('abort', cancel, { once: true });
        let settled = false;
        let resolveAnswers = () => { };
        const answered = new Promise(resolve => { resolveAnswers = resolve; });
        const params = {
            threadId: `claude:${sessionKey}`,
            turnId: queryId,
            itemId: toolOptions.toolUseID,
            isBlocking: true,
            questions,
        };
        const request = {
            ...params,
            kind: 'rpc',
            requestId: typeof toolOptions.requestId === 'string' ? toolOptions.requestId : toolOptions.toolUseID,
            signal: abort.signal,
            respond: value => new Promise((resolve, reject) => {
                if (settled) {
                    reject(new Error('User-input request is no longer active'));
                    return;
                }
                try {
                    const answers = validateAgentInputAnswers(params, value);
                    settled = true;
                    clearTimeout(timer);
                    resolveAnswers(answers);
                    resolve();
                }
                catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            }),
        };
        try {
            try {
                // Resolves when the question card is DELIVERED; the answer itself
                // arrives later through respond().
                await onUserInput(request, context);
            }
            catch {
                // Delivery failed before the card reached the user; any error class
                // means the question is unanswerable through this channel.
                abort.abort('unavailable');
                return { behavior: 'deny', message: DENY_DELIVERY };
            }
            const race = await Promise.race([
                answered,
                new Promise((_, reject) => {
                    // Listeners added to an already-aborted signal never fire.
                    if (abort.signal.aborted) {
                        reject(new Error(abort.signal.reason === 'expired' ? 'expired' : 'cancelled'));
                        return;
                    }
                    abort.signal.addEventListener('abort', () => reject(new Error(abort.signal.reason === 'expired' ? 'expired' : 'cancelled')), { once: true });
                }),
            ]).catch(error => error);
            if (race instanceof Error) {
                return { behavior: 'deny', message: race.message === 'expired' ? DENY_TIMEOUT : DENY_CANCELLED };
            }
            return { behavior: 'deny', message: formatAgentInputAnswers(questions, race) };
        }
        finally {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
            }
            toolOptions.signal.removeEventListener('abort', cancel);
        }
    };
}

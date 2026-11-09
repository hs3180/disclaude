/**
 * Model-configuration failure classification (Issue #4914 / T-088 rework 1).
 *
 * A failure whose text names THE MODEL as the problem — the model does not
 * exist, the account cannot access it, it was deactivated, or the upstream
 * itself says to try a different model — is exactly the moment a user wants
 * the native configuration card (`/agent config`). These signatures stay
 * narrow on purpose, mirroring `egress-failure.ts`:
 *
 * - credentials (401 / invalid api key) must NOT match — switching presets
 *   cannot fix a key, and the hint would misattribute the cause;
 * - bare `overloaded_error` / 5xx must NOT match — service-wide capacity is
 *   transient ("retry later" is the right advice), not a property of the
 *   selected model;
 * - egress/network texts have their own classifier and stay out of here.
 *
 * `model is at capacity` / `try a different model` DO match: the upstream
 * error explicitly recommends switching (observed Codex text: `Selected model
 * is at capacity. Please try a different model.`).
 */
// English: the model identifier itself is unknown to the upstream.
const MODEL_UNKNOWN = /\b(?:model[_ ]not[_ ]found|no such model|unknown model|unsupported model|invalid model(?:\s+(?:id|identifier|name))?)\b/i;
// OpenAI-style: "The model `gpt-5.6-luna` does not exist or you do not have
// access to it". The identifier slot admits dots (versioned model IDs), so a
// sentence-bound guard like [^.] would break on `gpt-5.6`.
const MODEL_DOES_NOT_EXIST = /\bmodel\b\s*[`'"“”]?[\w.:+/-]*[`'"“”]?\s+does not exist\b/i;
// Anthropic 404 body: "not_found_error: model: ..." — code and subject in either order.
const NOT_FOUND_MODEL = /\bnot_found_error\b[^.\n]{0,60}\bmodel\b|\bmodel\b[^.\n]{0,60}\bnot_found_error\b/i;
// Access class: the account lost/never had THIS model (not a credentials failure).
const MODEL_ACCESS = /\b(?:model[_ ]access[_ ]expired|model[_ ]deactivated|model[_ ]disabled)\b|\b(?:do(?:es)? not|don['’]t|cannot|can['’]t)\s+(?:have\s+)?access to (?:the|this) model\b/i;
// Per-model capacity where the upstream recommends switching (NOT bare 5xx).
const MODEL_CAPACITY = /\bmodel\b[^.\n]{0,40}\bis at capacity\b|\bselected model\b[^.\n]{0,60}\b(?:capacity|unavailable)\b|\btry (?:a|another|different) model\b/i;
// Chinese upstream bodies (GLM-side proxies): model missing / retired / no access.
const MODEL_ZH = /模型(?:不存在|已下线|已停用|不可用)|无权(?:使用|访问)(?:该|此)?模型/;
/** Whether a provider failure text points at the selected model itself. */
export function isModelSwitchFailure(text) {
    return (MODEL_UNKNOWN.test(text) ||
        MODEL_DOES_NOT_EXIST.test(text) ||
        NOT_FOUND_MODEL.test(text) ||
        MODEL_ACCESS.test(text) ||
        MODEL_CAPACITY.test(text) ||
        MODEL_ZH.test(text));
}

/**
 * ChatSessionPool - Agent pool for disclaude service.
 *
 * Manages ChatAgent instances for each chatId, using AgentFactory
 * from @disclaude/service to create ChatAgent instances.
 *
 * Issue #1499: Accepts optional MessageBuilderOptions for channel-specific
 * message building (e.g., Feishu sections). This decouples Feishu-specific
 * logic from the core agent runtime.
 *
 * @see Issue #1040 - Separate disclaude service code to @disclaude/service
 */
import { buildSessionKey, chatIdOfSessionKey, createLogger, getProvider, Config, resolveDefaultAgentRuntime, composeSessionRuntime, backendLlmCompatibility, switchableBackendsFor, isValidModelForBackend, SWITCHABLE_BACKENDS, validateAgentRuntimes, validateResolvedAgent, } from "../../core/dist/index.js";
import { statSync } from 'node:fs';
import { AgentFactory } from './agents/factory.js';
const logger = createLogger('ChatSessionPool');
/** Issue #4169: Default idle timeout before an inactive agent is evicted. */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** Issue #4169: Default idle-sweep interval. */
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Re-export so existing `./chat-session-pool.js` importers keep working; the
// implementation now lives in core next to buildSessionKey (PR #4590 review N4
// — the `::` separator had been hardcoded here and in the pool test mock).
export { chatIdOfSessionKey };
/**
 * ChatSessionPool - Manages ChatAgent instances for disclaude service.
 *
 * Each chatId gets its own ChatAgent instance with full MessageBuilder
 * support for enhanced prompts with context.
 *
 * Issue #4587 (part 2): topic-group threads get their OWN agent per thread.
 * Internally the pool keys agents on `buildSessionKey(chatId, threadRootId)`
 * (`chatId` for p2p/plain chats, `chatId::threadRoot` inside topic groups), so
 * each thread's context stays isolated. Everything user-facing — the agent's
 * `boundChatId` and callbacks — still receives the plain
 * `chatId`, so replies route to the chat exactly as before. Lazy migration:
 * messages without a `threadRootId` keep using the chat-scoped key, so
 * existing sessions are unaffected until a thread message starts a new one.
 */
export class ChatSessionPool {
    /** Release a completed temporary scope only if it still owns the pool slot. */
    releaseChatAgent(chatId, sessionId, agent) {
        const key = this.sessionKeyOf(chatId, sessionId);
        if (this.agents.get(key) !== agent) {
            return;
        }
        try {
            agent.reset();
        }
        finally {
            this.reset(chatId, false, sessionId);
        }
    }
    /** Keyed by buildSessionKey(chatId, threadRootId) — see class doc (Issue #4587 part 2). */
    agents = new Map();
    // Remember persistent topics after idle eviction too, so a Project change
    // forgets their native provider state. Isolated execution scopes pin their
    // own directory and never enter this registry.
    projectSessions = new Map();
    callbacksBySession = new Map();
    selectedPresetBySession = new Map();
    /**
     * Issue #5255: per-session orthogonal backend/model overrides, parallel to
     * selectedPresetBySession. Like the preset selection they survive reset()
     * and idle eviction, so a rebuilt agent recomposes the same dimensions
     * (getOrCreateChatAgent applies them at creation).
     */
    agentOverrideBySession = new Map();
    presets;
    options;
    /**
     * Issue #3696: session keys that should skip history loading on next agent
     * creation. Keyed like `agents` (Issue #4587 part 2) — a /reset in a thread
     * only skips history for that thread's next agent.
     */
    skipHistoryChatIds = new Set();
    /** Issue #4169: Last-used timestamp per session key, for idle eviction. */
    lastUsedAt = new Map();
    /** Issue #4169: Periodic sweep timer (unref'd) for idle eviction. */
    idleSweepTimer;
    /** Issue #4256: Peak concurrent agent count since pool start (leak diagnostics). */
    peakActive = 0;
    /**
     * Issue #4256: Cumulative idle-evictions since pool start (leak diagnostics).
     * Counts ONLY evictions from `evictIdleAgents()`; explicit `reset()` and
     * `disposeAll()` disposals are NOT included.
     */
    totalEvictions = 0;
    /**
     * Issue #4644: reset() hook into provider-side session state. Defaults to
     * the process-wide cached SDK provider (the same singleton every BaseAgent
     * agent resolves) so pool resets and agent-level resets hit one provider.
     */
    forgetProviderSession;
    isShuttingDown = false;
    constructor(options = {}) {
        this.options = options;
        this.forgetProviderSession =
            options.forgetProviderSession ??
                ((chatId) => {
                    getProvider().forgetSession?.(chatId);
                });
        this.presets = options.agentRuntimes ?? Config.getAgentRuntimes();
    }
    listAgentRuntimes() {
        return Object.entries(this.presets ?? {}).map(([name, preset]) => ({
            name,
            agentBackend: preset.agentBackend,
            model: preset.model,
            ...(preset.reasoningEffort ? { reasoningEffort: preset.reasoningEffort } : {}),
        }));
    }
    /**
     * Base preset selection shared by every caller: this session's explicit
     * /agent use > the chat's saved selection (#5476) > the owning app's or
     * named channel declaration's default (#5254/#5476) > the global default.
     */
    resolvePreset(chatId, sessionKey) {
        if (!this.presets) {
            return undefined;
        }
        const requested = this.selectedPresetBySession.get(sessionKey)
            ?? this.options.agentSelections?.get(chatId)?.presetName
            ?? this.options.defaultAgentRuntimeForChat?.(chatId);
        const harness = requested?.trim();
        if (harness) {
            return this.resolveHarness(harness);
        }
        // Issue #5255 r4: the default branch follows the same selection as the
        // loader/CLI (configured defaultHarness, then marker/declaration order).
        // The pool previously dropped defaultHarness here, silently diverging
        // from cli-main's explicit passes — this closes that behavior gap.
        return resolveDefaultAgentRuntime(this.presets, Config.getRawConfig().defaultHarness);
    }
    /** Issue #5255 r4: a named selection is a plain harness-key read. */
    resolveHarness(name) {
        const preset = this.presets?.[name];
        return preset
            ? { ok: true, name, preset }
            : { ok: false, error: `Unknown agent runtime: ${name}` };
    }
    getActiveAgentRuntime(chatId, threadRootId) {
        const sessionKey = this.sessionKeyOf(chatId, threadRootId);
        return this.activeDimensions(chatId, sessionKey);
    }
    /**
     * Issue #5255: base selection a session's orthogonal overrides compose
     * onto — the chat's resolved preset (via resolvePreset: this session's
     * switch > the chat's saved choice (#5476) > the per-app/channel default >
     * global default), or the process-wide singleton agent when no `agents:`
     * map exists.
     */
    sessionBase(chatId, sessionKey) {
        if (this.presets) {
            const resolved = this.resolvePreset(chatId, sessionKey);
            if (resolved && resolved.ok) {
                return { ok: true, name: resolved.name, preset: resolved.preset, binding: resolved.preset };
            }
            return resolved ?? { ok: false, error: 'No named agent runtimes are configured' };
        }
        try {
            const singleton = AgentFactory.resolveConfig({});
            return {
                ok: true,
                name: 'default',
                singleton,
                binding: { apiProtocol: singleton.apiProtocol, apiBaseUrl: singleton.apiBaseUrl },
            };
        }
        catch (error) {
            return {
                ok: false,
                error: `No named agent runtimes are configured and the default agent could not be resolved (${error instanceof Error ? error.message : String(error)})`,
            };
        }
    }
    /** Issue #5255: effective two-dimension view of a session's base + overrides. */
    activeDimensions(chatId, sessionKey) {
        const base = this.sessionBase(chatId, sessionKey);
        if (!base.ok) {
            return undefined;
        }
        return this.composeActive(base, this.agentOverrideBySession.get(sessionKey));
    }
    composeActive(base, override) {
        const overrideFields = {
            ...(override?.backendOverride ? { backendOverride: override.backendOverride } : {}),
            ...(override?.modelOverride ? { modelOverride: override.modelOverride } : {}),
        };
        if (base.preset) {
            const effective = composeSessionRuntime(base.preset, override);
            return {
                name: base.name,
                agentBackend: effective.agentBackend,
                model: effective.model,
                ...(effective.reasoningEffort ? { reasoningEffort: effective.reasoningEffort } : {}),
                ...overrideFields,
            };
        }
        const agentBackend = override?.backendOverride ?? base.singleton?.agentBackend;
        const model = override?.modelOverride ?? base.singleton?.model;
        if (!agentBackend || !model) {
            return undefined;
        }
        return { name: base.name, agentBackend, model, ...overrideFields };
    }
    /** Issue #5255: synthesize a preset for a backend override on the singleton default. */
    singletonPreset(agentBackend, base) {
        const singleton = base.singleton ?? {};
        return {
            agentBackend,
            llm: singleton.llm ?? '',
            model: singleton.model ?? '',
            apiKey: singleton.apiKey ?? '',
            ...(singleton.apiProtocol ? { apiProtocol: singleton.apiProtocol } : {}),
            ...(singleton.apiBaseUrl ? { apiBaseUrl: singleton.apiBaseUrl } : {}),
            ...(singleton.reasoningEffort !== undefined ? { reasoningEffort: singleton.reasoningEffort } : {}),
            ...(singleton.maxConcurrentSessions !== undefined ? { maxConcurrentSessions: singleton.maxConcurrentSessions } : {}),
            ...(singleton.env ? { env: singleton.env } : {}),
            ...(singleton.credentialEnvKeys ? { credentialEnvKeys: singleton.credentialEnvKeys } : {}),
        };
    }
    /** Issue #5255: store or clear a session's override envelope (empty envelope = no override). */
    setSessionOverride(sessionKey, override) {
        if (override?.backendOverride || override?.modelOverride) {
            this.agentOverrideBySession.set(sessionKey, override);
        }
        else {
            this.agentOverrideBySession.delete(sessionKey);
        }
    }
    /** Issue #5255: models of the configured presets usable on the session's effective backend. */
    modelOptions(chatId, sessionKey) {
        if (!this.presets) {
            return undefined;
        }
        const base = this.sessionBase(chatId, sessionKey);
        if (!base.ok) {
            return undefined;
        }
        const backend = this.agentOverrideBySession.get(sessionKey)?.backendOverride ?? base.preset?.agentBackend;
        const models = [...new Set(Object.values(this.presets)
                .map((preset) => preset.model)
                .filter((model) => model && (!backend || isValidModelForBackend(backend, model))))];
        return models.length ? models : undefined;
    }
    /**
     * Issue #5255: common switch safety sequence shared by `/agent use` and the
     * orthogonal backend/model switches — busy reject → availability probe →
     * candidate construction → provider forgetSession → atomic swap. Failure at
     * any step leaves the currently active session untouched.
     */
    activateAgentSelection(chatId, sessionKey, label, candidate) {
        const previous = this.agents.get(sessionKey);
        if (previous?.isBusy) {
            return { ok: false, error: 'The current chat is busy; wait for the response or use /stop before switching runtimes' };
        }
        let info;
        let backend;
        try {
            const config = candidate.preset
                ? AgentFactory.resolveConfig({ ...candidate.preset, settings: candidate.preset })
                : AgentFactory.resolveConfig(candidate.modelOverride !== undefined ? { model: candidate.modelOverride } : {});
            backend = candidate.preset?.agentBackend ?? config.agentBackend;
            if (!backend) {
                return { ok: false, error: `Could not validate agent ${label}: no agent backend is configured. Check backend configuration and availability; the current session is unchanged.` };
            }
            info = this.options.validateRuntimeBackend
                ? this.options.validateRuntimeBackend(backend, config)
                : getProvider(backend, candidate.preset).getInfo(config);
        }
        catch {
            return { ok: false, error: `Could not validate agent ${label}. Check backend configuration and availability; the current session is unchanged.` };
        }
        if (!info.available) {
            return { ok: false, error: `Agent ${label} is unavailable: ${info.unavailableReason ?? 'backend unavailable'}` };
        }
        const callbacks = this.callbacksBySession.get(sessionKey);
        let constructed;
        if (callbacks && previous) {
            try {
                constructed = this.createAgent(chatId, callbacks, candidate.preset, true, sessionKey, candidate.modelOverride);
            }
            catch (error) {
                return {
                    ok: false,
                    error: `Could not activate agent ${label}: ${error instanceof Error ? error.message : String(error)}`,
                };
            }
        }
        if (constructed) {
            // Construction is side-effect free with respect to the native SDK
            // session. Forget the selected backend only after construction succeeds,
            // so a failed switch leaves the currently active session untouched.
            try {
                if (backend) {
                    getProvider(backend, candidate.preset).forgetSession?.(sessionKey);
                }
                else {
                    this.forgetProviderSession(sessionKey);
                }
            }
            catch (error) {
                constructed.dispose();
                return {
                    ok: false,
                    error: `Could not start a fresh session for agent ${label}: ${error instanceof Error ? error.message : String(error)}`,
                };
            }
            this.agents.set(sessionKey, constructed);
            previous?.dispose();
        }
        else {
            // A command can select a target before this chat has created an agent.
            // Consume this marker on first use so persisted textual history is not
            // mistaken for cross-backend native-session migration.
            this.skipHistoryChatIds.add(sessionKey);
        }
        return { ok: true };
    }
    /** Refuse a chat-wide selection change while an affected session still owns work. */
    selectionChangeBusy(chatId) {
        return [...this.projectSessions.values()].some(scope => {
            if (scope.chatId !== chatId) {
                return false;
            }
            const key = this.sessionKeyOf(scope.chatId, scope.threadRootId);
            if (this.selectedPresetBySession.has(key)) {
                return false;
            }
            const agent = this.agents.get(key);
            return agent?.isBusy === true || agent?.hasPendingWork === true;
        });
    }
    /** Reset the chat's sessions that follow the chat-wide selection (#5476). */
    resetSelectionFollowingSessions(chatId) {
        for (const scope of this.projectSessions.values()) {
            if (scope.chatId !== chatId) {
                continue;
            }
            const key = this.sessionKeyOf(scope.chatId, scope.threadRootId);
            if (!this.selectedPresetBySession.has(key)) {
                this.reset(scope.chatId, undefined, scope.threadRootId);
            }
        }
    }
    /**
     * Select a preset for one chat/thread. Existing agents are replaced only
     * after the candidate backend and ChatAgent construct successfully, and —
     * when a selection store is wired — after the choice is durably saved for
     * the chat (#5476), so a failure leaves the current session untouched.
     * Other sessions of the same chat that follow the chat-wide selection are
     * reset to pick it up on their next message.
     */
    switchAgentRuntime(chatId, backend, model, threadRootId, actorId) {
        if (!this.presets) {
            return { ok: false, error: 'No named agent runtimes are configured (add an agents: map)' };
        }
        const harness = backend.trim();
        const resolved = harness
            ? this.resolveHarness(harness)
            : resolveDefaultAgentRuntime(this.presets, Config.getRawConfig().defaultHarness);
        if (!resolved.ok) {
            return resolved;
        }
        const sessionKey = this.sessionKeyOf(chatId, threadRootId);
        const previous = this.agents.get(sessionKey);
        if (previous?.isBusy) {
            return {
                ok: false,
                error: 'The current chat is busy; wait for the response or use /stop before switching runtimes',
            };
        }
        if (this.options.agentSelections && this.selectionChangeBusy(chatId)) {
            return { ok: false, error: 'Another session of this chat is busy; wait for the response or use /stop before switching runtimes' };
        }
        // `/agent use <harness> [model]` sets both dimensions at once: the named
        // harness is the durable base; a differing model rides as a session-scoped
        // override (persisted selection keeps only the harness, so a restart
        // reverts to the base — Issue #5255 r4 two-parameter form).
        const modelOverride = model?.trim() || undefined;
        if (modelOverride !== undefined && !isValidModelForBackend(resolved.preset.agentBackend, modelOverride)) {
            return {
                ok: false,
                error: `Model "${modelOverride}" is not a valid ${resolved.preset.agentBackend} model identifier.`,
                options: this.modelOptions(chatId, sessionKey),
            };
        }
        const effective = modelOverride && modelOverride !== resolved.preset.model
            ? composeSessionRuntime(resolved.preset, { modelOverride })
            : resolved.preset;
        let info;
        try {
            const config = AgentFactory.resolveConfig({ ...effective, settings: effective });
            info = this.options.validateRuntimeBackend
                ? this.options.validateRuntimeBackend(effective.agentBackend, config)
                : getProvider(effective.agentBackend, effective).getInfo(config);
        }
        catch {
            return {
                ok: false,
                error: `Could not validate agent runtime "${resolved.name}". Check backend configuration and availability; the current session is unchanged.`,
            };
        }
        if (!info.available) {
            return {
                ok: false,
                error: `Agent runtime "${resolved.name}" is unavailable: ${info.unavailableReason ?? 'backend unavailable'}`,
            };
        }
        const callbacks = this.callbacksBySession.get(sessionKey);
        let candidate;
        if (callbacks && previous) {
            try {
                candidate = this.createAgent(chatId, callbacks, effective, true, sessionKey);
            }
            catch (error) {
                return {
                    ok: false,
                    error: `Could not activate agent runtime "${resolved.name}": ${error instanceof Error ? error.message : String(error)}`,
                };
            }
        }
        // Persist before any destructive side effect (forgetSession/dispose) so a
        // failed save cannot leave the chat half-switched (#5476).
        if (this.options.agentSelections) {
            try {
                this.options.agentSelections.set(chatId, resolved.name, actorId ?? 'unknown');
            }
            catch (error) {
                candidate?.dispose();
                return {
                    ok: false,
                    error: `Could not save the agent selection for this chat: ${error instanceof Error ? error.message : String(error)}. The current session is unchanged.`,
                };
            }
        }
        if (candidate) {
            // Construction is side-effect free with respect to the native SDK
            // session. Forget the selected backend only after construction succeeds,
            // so a failed switch leaves the currently active session untouched.
            try {
                getProvider(effective.agentBackend, effective).forgetSession?.(sessionKey);
            }
            catch (error) {
                candidate.dispose();
                return {
                    ok: false,
                    error: `Could not start a fresh session for runtime "${resolved.name}": ${error instanceof Error ? error.message : String(error)}`,
                };
            }
            this.agents.set(sessionKey, candidate);
            previous?.dispose();
        }
        else {
            // A command can select a preset before this chat has created an agent.
            // Consume this marker on first use so persisted textual history is not
            // mistaken for cross-backend native-session migration.
            this.skipHistoryChatIds.add(sessionKey);
        }
        this.selectedPresetBySession.set(sessionKey, resolved.name);
        // `/agent use` sets both dimensions at once: any orthogonal override on
        // the previous selection is superseded; a differing model immediately
        // becomes the session's new override (Issue #5255).
        if (modelOverride && modelOverride !== resolved.preset.model) {
            this.setSessionOverride(sessionKey, { backendOverride: undefined, modelOverride });
        }
        else {
            this.agentOverrideBySession.delete(sessionKey);
        }
        // The issuing session now owns an explicit selection, so the sweep below
        // only resets the chat's other selection-following sessions (#5476).
        if (this.options.agentSelections) {
            this.resetSelectionFollowingSessions(chatId);
        }
        return {
            ok: true,
            active: {
                name: resolved.name,
                agentBackend: effective.agentBackend,
                model: effective.model,
                ...(effective.reasoningEffort ? { reasoningEffort: effective.reasoningEffort } : {}),
            },
            sessionBoundary: 'new-session',
        };
    }
    /**
     * Issue #5255: switch only the backend dimension, keeping the current
     * model. The llm binding is kept and judged for protocol compatibility
     * (claude needs anthropic; pi/dsh speak both, dsh needs baseUrl; codex
     * owns its connection). Incompatible targets answer with the backends the
     * binding can serve instead of hard-failing.
     */
    switchAgentBackend(chatId, backend, threadRootId) {
        const target = backend.trim().toLowerCase();
        const sessionKey = this.sessionKeyOf(chatId, threadRootId);
        const base = this.sessionBase(chatId, sessionKey);
        if (!base.ok) {
            return base;
        }
        if (!SWITCHABLE_BACKENDS.includes(target)) {
            return {
                ok: false,
                error: `Unknown agent backend: ${backend.trim() || '(empty)'}. Backends must be one of: ${SWITCHABLE_BACKENDS.join(', ')}.`,
                options: [...SWITCHABLE_BACKENDS],
            };
        }
        const compatibility = backendLlmCompatibility(target, base.binding);
        if (!compatibility.ok) {
            return {
                ok: false,
                error: `Cannot switch the backend to ${target}: ${compatibility.reason}.`,
                options: switchableBackendsFor(base.binding),
            };
        }
        const override = this.agentOverrideBySession.get(sessionKey);
        const baseBackend = base.preset?.agentBackend ?? base.singleton?.agentBackend;
        const nextOverride = {
            backendOverride: target === baseBackend ? undefined : target,
            modelOverride: override?.modelOverride,
        };
        const active = this.composeActive(base, nextOverride);
        if (!active) {
            return { ok: false, error: 'The active agent selection could not be resolved; the current session is unchanged.' };
        }
        const result = this.activateAgentSelection(chatId, sessionKey, `backend "${target}" on ${base.preset ? `runtime "${base.name}"` : 'the default agent'}`, base.preset
            ? { preset: composeSessionRuntime(base.preset, { backendOverride: target }) }
            : { preset: this.singletonPreset(target, base) });
        if (!result.ok) {
            return result;
        }
        this.setSessionOverride(sessionKey, nextOverride);
        return { ok: true, active, sessionBoundary: 'new-session' };
    }
    /**
     * Issue #5255: switch only the model dimension, keeping the current
     * backend (and its llm binding). Codex targets must be Codex/ChatGPT model
     * identifiers; other backends pass the identifier to the provider verbatim.
     */
    switchAgentModel(chatId, model, threadRootId) {
        const target = model.trim();
        const sessionKey = this.sessionKeyOf(chatId, threadRootId);
        if (!target) {
            return { ok: false, error: 'Usage: /agent model <model-id>', options: this.modelOptions(chatId, sessionKey) };
        }
        const base = this.sessionBase(chatId, sessionKey);
        if (!base.ok) {
            return base;
        }
        const override = this.agentOverrideBySession.get(sessionKey);
        const effectiveBackend = override?.backendOverride ?? base.preset?.agentBackend ?? base.singleton?.agentBackend;
        if (effectiveBackend && !isValidModelForBackend(effectiveBackend, target)) {
            return {
                ok: false,
                error: `Model "${target}" is not a valid ${effectiveBackend} model identifier.`,
                options: this.modelOptions(chatId, sessionKey),
            };
        }
        const baseModel = base.preset?.model ?? base.singleton?.model;
        const nextOverride = {
            backendOverride: override?.backendOverride,
            modelOverride: target === baseModel ? undefined : target,
        };
        const active = this.composeActive(base, nextOverride);
        if (!active) {
            return { ok: false, error: 'The active agent selection could not be resolved; the current session is unchanged.' };
        }
        const result = this.activateAgentSelection(chatId, sessionKey, `model "${target}" on ${base.preset ? `runtime "${base.name}"` : 'the default agent'}`, base.preset
            ? { preset: composeSessionRuntime(base.preset, { backendOverride: override?.backendOverride, modelOverride: target }) }
            : override?.backendOverride
                ? { preset: this.singletonPreset(override.backendOverride, base), modelOverride: target }
                : { modelOverride: target });
        if (!result.ok) {
            return result;
        }
        this.setSessionOverride(sessionKey, nextOverride);
        return { ok: true, active, sessionBoundary: 'new-session' };
    }
    /**
     * Issue #5731: resolve the runtime for a scoped execution. An explicit
     * `harness` names an `agents:` preset and is validated/preflighted with the
     * effective model before any pool state changes. It never reads or writes
     * the chat's persistent preset selection; without it, the #5476 resolution
     * chain (session switch > the chat's saved `/agent use` choice > per-app
     * default > global default, plus its legacy Config fallback) decides the
     * runtime exactly as before, and a model-only override is validated under
     * that resolved runtime's own rules.
     */
    resolveSessionPreset(session, chatId, sessionKey) {
        const harness = session?.harness?.trim();
        if (!harness) {
            if (session?.harness !== undefined) {
                throw new Error('Scheduled harness must be a non-empty named agent runtime');
            }
            const selected = this.resolvePreset(chatId, sessionKey);
            if (!selected?.ok) {
                // Preset-less and failed default resolution retain the legacy Config
                // fallback. That is deliberate for unspecified harnesses only.
                return undefined;
            }
            const modelOverride = session?.model?.trim();
            if (!modelOverride) {
                // A whitespace model-only override stays ignored, as the schedule
                // watcher documents; the resolved preset runs with its own model.
                return selected.preset;
            }
            // #5731 (model extension): the per-run model override follows the
            // RESOLVED runtime's rules (e.g. Codex requires a GPT identifier),
            // never the borrowed/other backend's, and fails loudly instead of
            // silently running the chat's default model.
            const effective = { ...selected.preset, model: modelOverride };
            this.validateScheduledPreset(selected.name, effective, 'Invalid scheduled model override for agent runtime');
            return effective;
        }
        if (!this.presets) {
            throw new Error(`Unknown scheduled harness "${harness}": no named agent runtimes are configured (add an agents: map)`);
        }
        const resolved = this.resolveHarness(harness);
        if (!resolved.ok) {
            throw new Error(`Unknown scheduled harness "${harness}": ${resolved.error}`);
        }
        const modelOverride = session?.model?.trim();
        if (session?.model !== undefined && !modelOverride) {
            throw new Error(`Scheduled harness "${resolved.name}" requires a non-empty model override`);
        }
        const preset = modelOverride === undefined
            ? resolved.preset
            : { ...resolved.preset, model: modelOverride };
        // Validate the effective harness+model pair under the selected backend's
        // rules (not the chat binding's): notably Codex requires a GPT identifier.
        this.validateScheduledPreset(resolved.name, preset, 'Invalid scheduled harness');
        const credentialError = validateResolvedAgent(preset);
        if (credentialError) {
            throw new Error(`Invalid scheduled harness "${resolved.name}": ${credentialError}`);
        }
        let info;
        try {
            const config = AgentFactory.resolveConfig({ ...preset, settings: preset });
            info = this.options.validateRuntimeBackend
                ? this.options.validateRuntimeBackend(preset.agentBackend, config)
                : getProvider(preset.agentBackend, preset).getInfo(config);
        }
        catch (error) {
            logger.error({ err: error, harness: resolved.name, agentBackend: preset.agentBackend }, 'Scheduled harness preflight failed');
            throw new Error(`Could not validate scheduled harness "${resolved.name}". Check backend configuration and availability; no execution state was changed.`);
        }
        if (!info.available) {
            throw new Error(`Scheduled harness "${resolved.name}" is unavailable: ${info.unavailableReason ?? 'backend unavailable'}`);
        }
        return preset;
    }
    /**
     * Validate a per-execution preset under the named runtime's own model rules
     * (#5731): the pair must satisfy the backend the run will actually use
     * (notably Codex requires a GPT identifier), instead of silently adopting
     * the model of the chat's binding or the global default.
     */
    validateScheduledPreset(name, preset, label) {
        const validation = validateAgentRuntimes({ [name]: preset }, { allowUnconfiguredModel: true });
        if (!validation.ok) {
            throw new Error(`${label} "${name}": ${validation.errors.join('; ')}`);
        }
    }
    createAgent(chatId, callbacks, preset, skipHistory = false, sdkSessionKey = chatId, modelOverride, freezeDirectory = false) {
        let { cwdProvider, cwdResolver } = this.options;
        const { configureQueryOptions } = this.options;
        if (freezeDirectory) {
            const initial = cwdResolver?.(chatId);
            // Preserve an unavailable bound target too: taking effectiveCwd alone
            // would silently adopt the workspace fallback instead of rejecting it.
            const directory = initial?.boundWorkingDir ?? initial?.effectiveCwd ?? cwdProvider?.(chatId);
            if (directory !== undefined) {
                cwdProvider = () => directory;
                cwdResolver = () => {
                    let available = false;
                    try {
                        available = statSync(directory).isDirectory();
                    }
                    catch {
                        /* fail closed */
                    }
                    return {
                        effectiveCwd: directory,
                        boundWorkingDir: directory,
                        reason: available ? 'bound' : 'bound-missing',
                    };
                };
            }
        }
        return AgentFactory.createChatAgent('pilot', chatId, callbacks, {
            messageBuilderOptions: this.options.messageBuilderOptions,
            cwdProvider,
            cwdResolver,
            skipHistory,
            sdkSessionKey,
            turnRecovery: this.options.turnRecovery,
            failureRecorder: this.options.failureRecorder,
            ...(configureQueryOptions
                ? {
                    configureQueryOptions: (options) => configureQueryOptions(options, chatId),
                }
                : {}),
            ...(preset
                ? {
                    ...preset,
                    settings: preset,
                }
                : {}),
            ...(modelOverride !== undefined ? { model: modelOverride } : {}),
        });
    }
    /**
     * Issue #4587 (part 2): pool map key for a chat/thread pair.
     * `chatId::threadRoot` for topic-group threads, plain `chatId` otherwise
     * (delegates to the #4305 part-1 primitive).
     */
    sessionKeyOf(chatId, threadRootId) {
        return buildSessionKey(chatId, threadRootId);
    }
    /**
     * Get the ChatAgent for a chatId without creating one.
     * Issue #3931: Used for internal lookups (e.g., isAgentBusy).
     * Issue #4587 (part 2): `threadRootId` selects a topic-group thread's agent.
     *
     * @param chatId - Chat ID to look up
     * @param threadRootId - Optional thread root (topic groups only)
     * @returns ChatAgent if one exists, undefined otherwise
     */
    get(chatId, threadRootId) {
        return this.agents.get(this.sessionKeyOf(chatId, threadRootId));
    }
    /**
     * Check if the agent for a chatId is currently busy processing.
     * Issue #3931: Encapsulates the busy check so callers don't depend
     * on ChatAgent internals. Uses ChatAgent.isBusy (based on
     * isProcessingMessage flag per Issue #3985) rather than taskComplete
     * to avoid timing windows.
     *
     * Issue #4587 (part 2): with `threadRootId`, checks that thread's agent.
     * Without it, checks the chat-scoped agent (scheduler/loop callers) — a busy
     * thread does NOT make the chat-scoped agent look busy.
     *
     * @param chatId - Chat ID to check
     * @param threadRootId - Optional thread root (topic groups only)
     * @returns true if the agent exists and is busy processing a message
     */
    isAgentBusy(chatId, threadRootId) {
        const agent = this.agents.get(this.sessionKeyOf(chatId, threadRootId));
        return agent ? agent.isBusy : false;
    }
    /**
     * Get or create a ChatAgent instance for the given chatId.
     *
     * Issue #3776: When an agent already exists, updates its callbacks to match
     * the current message's channel. This ensures responses are routed correctly
     * when multiple channels (e.g., Feishu and REST) share the same chatId.
     *
     * Issue #4587 (part 2): a topic-group `threadRootId` selects that thread's
     * agent — one agent per thread, so thread contexts stay isolated. The agent
     * itself is still constructed with the plain `chatId` (boundChatId, history,
     * callbacks all stay chat-scoped); only the pool slot is per-thread. Lazy
     * migration: messages without a `threadRootId` use the chat-scoped slot, so
     * pre-existing chat sessions keep their agent untouched.
     *
     * @param chatId - Chat ID to get/create agent for
     * @param callbacks - Callbacks for the current channel (used for new agents
     *   or to update existing agents)
     * @param threadRootId - Optional thread root; present only for topic-group
     *   messages (part 1 pipeline). Omitted for p2p, plain groups, and
     *   scheduler/loop system messages.
     * @returns ChatAgent instance
     */
    getOrCreateChatAgent(chatId, callbacks, threadRootId, session) {
        if (this.isShuttingDown) {
            throw new Error('Disclaude service is shutting down; the message was not started');
        }
        if (session && (!session.id.trim() || (threadRootId && threadRootId !== session.id))) {
            throw new Error('Agent session must have a nonempty, unambiguous scope');
        }
        const sessionKey = this.sessionKeyOf(chatId, session?.id ?? threadRootId);
        let agent = this.agents.get(sessionKey);
        if (agent && session?.releaseAfterTurn) {
            throw new Error('Temporary session already owns an agent');
        }
        if (!agent) {
            const skipHistory = session?.skipHistory ?? this.skipHistoryChatIds.has(sessionKey);
            // Scoped scheduled executions (#5731: an explicit per-run `harness` or
            // `model`) resolve their runtime without reading the chat's interactive
            // dimension overrides. Interactive sessions instead compose the
            // session's orthogonal overrides onto the chat's resolved base
            // selection (session switch > saved choice > per-app default > global,
            // #5476; or the singleton default when no agents: map exists) at
            // creation, so a rebuilt agent — after reset or idle eviction — keeps
            // the same dimensions (#5255).
            const scoped = session?.harness !== undefined || session?.model !== undefined;
            let preset;
            let modelArg;
            if (scoped) {
                preset = this.resolveSessionPreset(session, chatId, sessionKey);
                // A resolved execution preset already carries its validated model
                // override; pass the model through only on the legacy Config fallback.
                modelArg = preset ? undefined : session?.model?.trim() || undefined;
            }
            else {
                const override = this.agentOverrideBySession.get(sessionKey);
                if (this.presets) {
                    const base = this.sessionBase(chatId, sessionKey);
                    if (base.ok && base.preset) {
                        preset = composeSessionRuntime(base.preset, override);
                    }
                }
                else if (override?.backendOverride) {
                    // No agents: map — carry the singleton default's llm binding onto the
                    // overridden backend. If even the singleton cannot be resolved, leave
                    // the preset unset: construction surfaces the same configuration error.
                    const base = this.sessionBase(chatId, sessionKey);
                    if (base.ok) {
                        preset = this.singletonPreset(override.backendOverride, base);
                    }
                }
                modelArg = override?.modelOverride;
            }
            agent = this.createAgent(chatId, callbacks, preset, skipHistory, sessionKey, modelArg, session !== undefined);
            this.agents.set(sessionKey, agent);
            // Issue #3696: clear skip-history flag after agent creation
            this.skipHistoryChatIds.delete(sessionKey);
        }
        else {
            // Issue #3776: Update callbacks so responses route to the correct channel.
            // Without this, REST Channel responses go to Feishu's callbacks (which
            // don't resolve PendingResponse), causing HTTP timeouts.
            //
            // updateCallbacks() handles concurrency: if the agent is busy, the update
            // is deferred until the current query completes.
            agent.updateCallbacks(callbacks);
        }
        // Rejected requests must not replace the delivery owner used by preset switches.
        this.callbacksBySession.set(sessionKey, callbacks);
        if (!session) {
            this.projectSessions.set(sessionKey, { chatId, threadRootId });
        }
        // Issue #4169: Track usage for idle eviction.
        this.lastUsedAt.set(sessionKey, Date.now());
        // Issue #4256: Track peak concurrent agents for leak diagnostics. Each
        // agent holds a query handle and SDK resources (including child processes
        // for explicitly configured external tools), so the active count is
        // the observable proxy for the per-process resource/subprocess ceiling.
        if (this.agents.size > this.peakActive) {
            this.peakActive = this.agents.size;
            // Issue #4256 (part 2): emit an immediate snapshot on a new high-water
            // mark so a sudden spike is visible without waiting for the next sweep
            // tick (default 5 min). Monotonic (peak only rises), so bounded by the
            // eventual ceiling — not noisy.
            this.logPoolSnapshot('peak');
        }
        return agent;
    }
    /** Whether any persistent session affected by a Project change still owns work. */
    isProjectBusy(chatId) {
        for (const [key, scope] of this.projectSessions) {
            if (scope.chatId !== chatId) {
                continue;
            }
            const agent = this.agents.get(key);
            // The pending-work signal also covers history admission and background
            // tasks in runtimes that expose it, beyond the current visible turn.
            if (agent && (agent.isBusy || ('hasPendingWork' in agent && agent.hasPendingWork === true))) {
                return true;
            }
        }
        return false;
    }
    /** Refresh the chat-wide binding without resetting directory-pinned executions. */
    resetProjectSessions(chatId) {
        const roots = new Set([
            undefined,
            ...[...this.projectSessions.values()]
                .filter((scope) => scope.chatId === chatId)
                .map((scope) => scope.threadRootId),
        ]);
        for (const threadRootId of roots) {
            this.reset(chatId, undefined, threadRootId);
        }
    }
    /**
     * Reset the ChatAgent for a chatId by disposing the old instance.
     *
     * Issue #3570: Instead of just clearing conversation context on the existing
     * agent, we dispose it completely and remove it from the pool. The next
     * getOrCreateChatAgent() call will create a fresh agent instance.
     *
     * This ensures all resources (SDK connections, event listeners, transports,
     * AbortControllers) are properly released rather than accumulated across
     * multiple /reset operations.
     *
     * @param chatId - Chat ID to reset
     * @param skipContext - If true, the next `getOrCreateChatAgent()` for this
     *   chat creates a fresh agent that SKIPS reloading persisted history (a true
     *   fresh session — used by the schedule `clearContext` option, Issue #4206).
     *   The flag is consumed (deleted) by that next getOrCreate. If false/omitted,
     *   the next agent reloads history normally.
     *
     *   Note the inverted polarity vs `ChatAgent.reset(chatId, keepContext)`:
     *   there `true` means keep context, here `true` means skip it.
     * @param threadRootId - Optional thread root (Issue #4587 part 2): reset only
     *   that thread's agent instead of the chat-scoped one. `/reset` inside a
     *   topic-group thread clears that thread's context; other threads and the
     *   chat-scoped agent are untouched. Omitted (scheduler/control commands
     *   today) resets the chat-scoped agent.
     */
    reset(chatId, skipContext, threadRootId) {
        const sessionKey = this.sessionKeyOf(chatId, threadRootId);
        this.projectSessions.delete(sessionKey);
        // Callbacks capture channel/request state and are only needed while an
        // agent occupies this slot. Preset selection intentionally survives reset.
        this.callbacksBySession.delete(sessionKey);
        if (skipContext) {
            this.skipHistoryChatIds.add(sessionKey);
        }
        else {
            // Issue #4206 (review nit): a non-skip reset means "start fresh WITH
            // history next time". Clear any stale skip-history flag left by a prior
            // reset(chatId, true) whose consuming getOrCreate never ran — e.g. a
            // clearContext scheduled task that failed before routing. Without this,
            // that stale flag would leak to the next unrelated message and silently
            // drop its history.
            this.skipHistoryChatIds.delete(sessionKey);
        }
        // Issue #4644: clear provider-side session state BEFORE the agent lookup —
        // it must fire even when no ChatAgent instance exists (the chat may have
        // been idle-evicted from this pool while its codex stash lived on). Keyed
        // by the same scoped native session key used during construction.
        // Issue #5255: the EFFECTIVE backend (chat's resolved preset + backend
        // override) owns the native session, so forget through the composed preset.
        const base = this.sessionBase(chatId, sessionKey);
        const effectiveOverride = this.agentOverrideBySession.get(sessionKey);
        if (base.ok && base.preset) {
            const effective = composeSessionRuntime(base.preset, effectiveOverride);
            getProvider(effective.agentBackend, effective).forgetSession?.(sessionKey);
        }
        else {
            this.forgetProviderSession(sessionKey);
        }
        const agent = this.agents.get(sessionKey);
        if (agent) {
            this.agents.delete(sessionKey);
            this.lastUsedAt.delete(sessionKey);
            agent.dispose();
        }
    }
    /**
     * Stop the current query for a chatId without resetting the session.
     * Issue #1349: /stop command
     * Issue #4587 (part 2): `threadRootId` stops that thread's agent only.
     *
     * @param chatId - Chat ID to stop
     * @param threadRootId - Optional thread root (topic groups only)
     * @returns true if a query was stopped, false if no active query
     */
    stop(chatId, threadRootId) {
        const agent = this.agents.get(this.sessionKeyOf(chatId, threadRootId));
        if (agent) {
            return agent.stop(chatId);
        }
        return false;
    }
    canSteer(chatId, threadRootId) {
        return this.agents.get(this.sessionKeyOf(chatId, threadRootId))?.canSteer() ?? false;
    }
    async steer(chatId, prompt, threadRootId) {
        const agent = this.agents.get(this.sessionKeyOf(chatId, threadRootId));
        if (!agent?.isBusy) {
            return {
                ok: false,
                error: 'No active turn to steer. Send the message normally to start or queue a turn.',
            };
        }
        try {
            const result = await agent.steer(prompt);
            return result.ok
                ? { ok: true, message: `Steer acknowledged for active turn ${result.turnId}.` }
                : result;
        }
        catch (error) {
            return {
                ok: false,
                error: `Steer failed before acknowledgement: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }
    /**
     * Dispose all agents and clear the pool.
     */
    disposeAll() {
        this.stopIdleSweep();
        for (const agent of this.agents.values()) {
            agent.dispose();
        }
        this.agents.clear();
        this.projectSessions.clear();
        this.lastUsedAt.clear();
        this.callbacksBySession.clear();
        this.selectedPresetBySession.clear();
        this.agentOverrideBySession.clear();
    }
    /**
     * Stop accepting new turns, allow a bounded drain, then persist and report
     * any remaining turns as interrupted before releasing their agents.
     */
    async shutdownForServiceRestart(options = {}) {
        this.isShuttingDown = true;
        this.stopIdleSweep();
        for (const agent of this.agents.values()) {
            agent.beginServiceShutdown();
        }
        const drainTimeoutMs = Math.max(0, options.drainTimeoutMs ?? 10_000);
        const noticeTimeoutMs = Math.max(0, options.noticeTimeoutMs ?? 2_000);
        const deadline = Date.now() + drainTimeoutMs;
        const hasPendingWork = () => [...this.agents.values()].some((agent) => agent.hasPendingWork);
        while (hasPendingWork() && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
        }
        const remaining = [...this.agents.entries()].filter(([, agent]) => agent.hasPendingWork);
        if (remaining.length > 0) {
            logger.warn({
                count: remaining.length,
                sessionKeys: remaining.map(([sessionKey]) => sessionKey),
                drainTimeoutMs,
            }, 'Service shutdown drain expired; interrupting remaining agent turns (Issue #5273)');
            await Promise.allSettled(remaining.map(([, agent]) => agent.interruptForServiceRestart(noticeTimeoutMs)));
        }
        this.disposeAll();
    }
    /**
     * Issue #4169: Start periodic eviction of idle agents.
     *
     * The agent pool is unbounded by default — every chatId gets a persistent
     * ChatAgent that is only released on explicit `/reset` or shutdown. Over long
     * runs this accumulates memory (each agent holds a query handle, channel, MCP
     * connections, listeners). The idle sweep disposes agents that haven't been
     * used for `idleTimeoutMs`, releasing those resources. Busy agents are never
     * evicted mid-turn. The timer is `unref`'d so it never keeps the process alive.
     *
     * Issue #4256 (part 2): the periodic pool-snapshot runs even when idle
     * eviction is disabled (`idleTimeoutMs <= 0`) — `evictIdleAgents()` is a
     * no-op in that case, but the leak-diagnostics snapshot still fires, so
     * monitoring stays live precisely when an unbounded pool is most likely to
     * leak.
     */
    startIdleSweep() {
        if (this.idleSweepTimer) {
            return;
        }
        const interval = this.options.idleSweepIntervalMs ?? DEFAULT_IDLE_SWEEP_INTERVAL_MS;
        this.idleSweepTimer = setInterval(() => {
            const evicted = this.evictIdleAgents();
            if (evicted.length) {
                logger.info({ count: evicted.length }, 'Evicted idle agents (Issue #4169)');
            }
            // Issue #4256 (part 2): periodic pool-state snapshot for leak
            // diagnostics. A monotonic active/peak growth despite eviction, or a
            // busy count that never returns to zero, signals agents (and their
            // configured tool subprocesses) are not being released — see #4169/#4256.
            this.logPoolSnapshot('idle-sweep');
        }, interval);
        this.idleSweepTimer.unref?.();
    }
    /**
     * Issue #4169: Evict (dispose) agents idle longer than the idle timeout.
     *
     * Active turns, admitted/queued requests, and live background tasks are
     * protected from idle disposal until the work completes or is explicitly
     * stopped. The pool never stops pending work based on elapsed time.
     *
     * @param now - Injectable clock for deterministic testing (defaults to Date.now()).
     * @returns Session keys of the agents that were evicted. Issue #4587 (part 2):
     *   these are `buildSessionKey()` values — plain chatIds for chat-scoped
     *   agents, `chatId::threadRoot` for topic-group thread agents.
     */
    evictIdleAgents(now = Date.now()) {
        const timeout = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
        const evicted = [];
        for (const [sessionKey, agent] of this.agents) {
            // An admitted message or a live background task is work even when the
            // main SDK turn has not started or has already returned its result.
            if (agent.isBusy || agent.hasPendingWork) {
                continue;
            }
            if (timeout <= 0) {
                continue;
            }
            const last = Math.max(this.lastUsedAt.get(sessionKey) ?? now, agent.lastActivityAt ?? 0);
            if (now - last >= timeout) {
                logger.info({
                    sessionKey,
                    isBusy: agent.isBusy,
                    hasPendingWork: agent.hasPendingWork,
                    backgroundTaskCount: agent.activeBackgroundTaskCount ?? 0,
                    turnStartedAtMs: agent.turnStartedAtMs,
                    lastUsedAt: last,
                    lastActivityAt: agent.lastActivityAt,
                    lastActivityType: agent.lastActivityType,
                    idleTimeoutMs: timeout,
                    idleMs: now - last,
                }, 'Evicting inactive agent');
                this.agents.delete(sessionKey);
                this.lastUsedAt.delete(sessionKey);
                // Do not retain channel closures after the owning agent is evicted.
                // selectedPresetBySession remains so the next agent uses the same preset.
                this.callbacksBySession.delete(sessionKey);
                agent.dispose();
                evicted.push(sessionKey);
            }
        }
        // Issue #4256: tally evictions for the leak-diagnostics snapshot.
        this.totalEvictions += evicted.length;
        return evicted;
    }
    /**
     * Issue #4256 (part 2): snapshot of pool state for leak diagnostics.
     *
     * Each active agent holds a query handle, input channel, and SDK resources
     * (including child processes for explicitly configured external tools). The active/peak/eviction counts are the observable per-process
     * proxy for that resource footprint, letting operators spot a leak (e.g.
     * active grows monotonically, or busy never returns to zero) without
     * enumerating live subprocesses.
     *
     * Surfaced on the REST `/api/health` endpoint so operators can query live
     * pool state without scraping logs.
     *
     * @returns A structured snapshot of current and cumulative pool state.
     */
    getPoolStats() {
        let busy = 0;
        for (const agent of this.agents.values()) {
            if (agent.isBusy) {
                busy++;
            }
        }
        return {
            active: this.agents.size,
            busy,
            idle: this.agents.size - busy,
            peakActive: this.peakActive,
            totalEvictions: this.totalEvictions,
        };
    }
    /**
     * Issue #4256 (part 2): emit a structured pool-state snapshot log. Called on
     * each idle sweep (and available for ad-hoc diagnostics). Pure observability
     * — no behavior change.
     *
     * @param reason - What triggered the snapshot (e.g. 'idle-sweep').
     */
    logPoolSnapshot(reason) {
        const stats = this.getPoolStats();
        logger.info({ reason, ...stats }, 'Agent pool snapshot (Issue #4256)');
    }
    /**
     * Issue #4169: Stop the idle-eviction sweep timer.
     */
    stopIdleSweep() {
        if (this.idleSweepTimer) {
            clearInterval(this.idleSweepTimer);
            this.idleSweepTimer = undefined;
        }
    }
}

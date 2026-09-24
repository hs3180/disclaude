/**
 * Interactive Context Store.
 *
 * Manages interactive message contexts (action prompt registration, lookup,
 * generation, and cleanup) for the disclaude service. This module is the single
 * source of truth for interactive card action prompts, eliminating the
 * previous cross-process state dependency on MCP Server.
 *
 * Part of Phase 3 (#1572) of REST API layer responsibility refactoring (#1568).
 *
 * @module interactive-context
 */
import { createLogger } from "../../core/dist/index.js";
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
const logger = createLogger('InteractiveContextStore');
/**
 * Escape template placeholder syntax in a value to prevent injection.
 * Replaces `{{` with `\{\{` and `}}` with `\}\}` to prevent user-supplied
 * values from being interpreted as template placeholders during subsequent
 * replacement passes (#2247).
 */
function escapeTemplatePlaceholders(value) {
    return value.replace(/\{\{/g, '\\{\\{').replace(/\}\}/g, '\\}\\}');
}
/**
 * Default maximum number of interactive contexts to retain per chatId.
 * Older entries are evicted when this limit is exceeded (LRU-style).
 */
const DEFAULT_MAX_ENTRIES_PER_CHAT = 10;
/**
 * InteractiveContextStore - Manages interactive message contexts.
 *
 * Provides methods for registering, looking up, and cleaning up
 * action prompt contexts for interactive cards.
 *
 * Supports two lookup strategies:
 * 1. By messageId (exact match)
 * 2. By chatId (searches all contexts for a chat, used as fallback
 *    when the real Feishu messageId doesn't match the synthetic messageId used
 *    during registration)
 *
 * The chatId index stores multiple messageIds per chat to support coexistence
 * of multiple interactive cards in the same chat (#1625).
 *
 * An inverted index (actionValueIndex) provides O(1) lookup of actionValue
 * to messageId within a chat, optimizing the cross-card search path.
 */
export class InteractiveContextStore {
    persistenceFile;
    contexts = new Map();
    /**
     * Index: chatId → ordered list of messageIds (oldest first).
     * Used for chatId-based fallback lookup when the exact messageId is unknown.
     * Capped at maxEntriesPerChat to prevent unbounded memory growth.
     */
    chatIdIndex = new Map();
    /**
     * Inverted index: chatId → (actionValue → messageId[]).
     * Enables O(1) lookup for findActionPromptsByChatId() instead of O(n×m).
     * Stores multiple messageIds per actionValue to support coexistence of
     * cards with shared actionValue names in the same chat (#2247).
     * Updated on register/unregister/cleanupExpired/clear.
     */
    actionValueIndex = new Map();
    /** Maximum age for contexts before cleanup (default: 24 hours) */
    maxAge;
    /** Maximum number of contexts to retain per chatId */
    maxEntriesPerChat;
    restoring = false;
    constructor(maxAge, maxEntriesPerChat, persistenceFile) {
        this.persistenceFile = persistenceFile;
        this.maxAge = maxAge ?? 24 * 60 * 60 * 1000;
        this.maxEntriesPerChat = maxEntriesPerChat ?? DEFAULT_MAX_ENTRIES_PER_CHAT;
        if (persistenceFile) {
            let serialized;
            try {
                serialized = readFileSync(persistenceFile, 'utf8');
            }
            catch (error) {
                if (error.code === 'ENOENT') {
                    return;
                }
                throw error;
            }
            const stored = JSON.parse(serialized);
            if (!stored || typeof stored !== 'object' || !('version' in stored) || stored.version !== 1
                || !('contexts' in stored) || !Array.isArray(stored.contexts)) {
                throw new Error('Invalid interactive context store; original file preserved');
            }
            const ids = new Set();
            for (const entry of stored.contexts) {
                if (!entry || typeof entry !== 'object' || typeof entry.messageId !== 'string' || !entry.messageId
                    || typeof entry.chatId !== 'string' || !entry.chatId || ids.has(entry.messageId)
                    || !Number.isFinite(entry.createdAt) || entry.createdAt < 0
                    || !entry.actionPrompts || typeof entry.actionPrompts !== 'object' || Array.isArray(entry.actionPrompts)
                    || Object.values(entry.actionPrompts).some(value => typeof value !== 'string' || !value)) {
                    throw new Error('Invalid interactive context entry; original file preserved');
                }
                if (entry.actionLabels !== undefined && (!entry.actionLabels || typeof entry.actionLabels !== 'object'
                    || Array.isArray(entry.actionLabels) || Object.values(entry.actionLabels).some(value => typeof value !== 'string' || !value))) {
                    throw new Error('Invalid interactive context labels; original file preserved');
                }
                ids.add(entry.messageId);
            }
            this.restore(stored.contexts);
        }
    }
    restore(entries) {
        this.restoring = true;
        try {
            this.clear();
            for (const entry of entries) {
                if (Date.now() - entry.createdAt > this.maxAge) {
                    continue;
                }
                this.register(entry.messageId, entry.chatId, entry.actionPrompts, entry.actionLabels);
                const restored = this.contexts.get(entry.messageId);
                if (restored) {
                    restored.createdAt = entry.createdAt;
                }
            }
        }
        finally {
            this.restoring = false;
        }
    }
    snapshot() {
        return this.persistenceFile && !this.restoring ? structuredClone([...this.contexts.values()]) : [];
    }
    /** Single service writer; publish a complete snapshot atomically, or restore memory. */
    persist(previous) {
        if (!this.persistenceFile || this.restoring) {
            return;
        }
        const temporary = `${this.persistenceFile}.${randomUUID()}.tmp`;
        try {
            mkdirSync(dirname(this.persistenceFile), { recursive: true, mode: 0o700 });
            writeFileSync(temporary, JSON.stringify({ version: 1, contexts: [...this.contexts.values()] }), { flag: 'wx', mode: 0o600 });
            renameSync(temporary, this.persistenceFile);
        }
        catch (error) {
            this.restore(previous);
            throw error;
        }
        finally {
            rmSync(temporary, { force: true });
        }
    }
    /**
     * Register action prompts for a message.
     *
     * Multiple contexts can coexist for the same chatId. When the per-chat
     * limit is exceeded, the oldest entries are evicted (LRU-style).
     *
     * @param messageId - Message ID (from Feishu or synthetic)
     * @param chatId - Chat ID where the card was sent
     * @param actionPrompts - Map of action values to prompt templates
     */
    register(messageId, chatId, actionPrompts, actionLabels) {
        if (typeof messageId !== 'string' || !messageId || typeof chatId !== 'string' || !chatId
            || !actionPrompts || typeof actionPrompts !== 'object' || Array.isArray(actionPrompts)
            || Object.values(actionPrompts).some(value => typeof value !== 'string' || !value)) {
            throw new Error('Invalid interactive context registration');
        }
        if (actionLabels !== undefined && (!actionLabels || typeof actionLabels !== 'object'
            || Array.isArray(actionLabels) || Object.values(actionLabels).some(value => typeof value !== 'string' || !value))) {
            throw new Error('Invalid interactive context labels');
        }
        const previous = this.snapshot();
        // Preserve registration order in persisted snapshots as well as chat indexes.
        this.contexts.delete(messageId);
        this.contexts.set(messageId, {
            messageId,
            chatId,
            actionPrompts: { ...actionPrompts },
            ...(actionLabels ? { actionLabels: { ...actionLabels } } : {}),
            createdAt: Date.now(),
        });
        // Update chatId index: append messageId, deduplicate, enforce LRU limit
        const chatExisting = this.chatIdIndex.get(chatId) || [];
        const chatFiltered = chatExisting.filter((id) => id !== messageId);
        chatFiltered.push(messageId);
        // Evict oldest entries when limit exceeded
        if (chatFiltered.length > this.maxEntriesPerChat) {
            const evicted = chatFiltered.splice(0, chatFiltered.length - this.maxEntriesPerChat);
            for (const evictedId of evicted) {
                // Only remove from contexts if it hasn't been re-registered under a different chatId
                const ctx = this.contexts.get(evictedId);
                if (ctx && ctx.chatId === chatId) {
                    this.contexts.delete(evictedId);
                    this.removeFromActionValueIndex(chatId, evictedId, ctx.actionPrompts);
                }
            }
        }
        this.chatIdIndex.set(chatId, chatFiltered);
        // Update inverted index: chatId → actionValue → messageId[]
        let avMap = this.actionValueIndex.get(chatId);
        if (!avMap) {
            avMap = new Map();
            this.actionValueIndex.set(chatId, avMap);
        }
        for (const actionValue of Object.keys(actionPrompts)) {
            const avExisting = avMap.get(actionValue) || [];
            // Deduplicate: remove this messageId if already present
            const avFiltered = avExisting.filter((id) => id !== messageId);
            // Append to end (newest last)
            avFiltered.push(messageId);
            avMap.set(actionValue, avFiltered);
        }
        this.persist(previous);
        logger.debug({ messageId, chatId, actions: Object.keys(actionPrompts), totalForChat: chatFiltered.length }, 'Action prompts registered');
    }
    /**
     * Remove entries from the inverted index for a given chatId/messageId pair.
     */
    removeFromActionValueIndex(chatId, messageId, actionPrompts) {
        const avMap = this.actionValueIndex.get(chatId);
        if (!avMap) {
            return;
        }
        for (const actionValue of Object.keys(actionPrompts)) {
            const existing = avMap.get(actionValue);
            if (!existing) {
                continue;
            }
            // Remove this messageId from the array
            const filtered = existing.filter((id) => id !== messageId);
            if (filtered.length === 0) {
                avMap.delete(actionValue);
            }
            else {
                avMap.set(actionValue, filtered);
            }
        }
        // Clean up empty maps
        if (avMap.size === 0) {
            this.actionValueIndex.delete(chatId);
        }
    }
    /**
     * Get action prompts for a message.
     *
     * @param messageId - Message ID to look up
     * @returns Action prompt map, or undefined if not found
     */
    getActionPrompts(messageId) {
        const context = this.contexts.get(messageId);
        return context?.actionPrompts;
    }
    getActionText(messageId, chatId, actionValue) {
        const context = this.contexts.get(messageId);
        if (!context || context.chatId !== chatId || Date.now() - context.createdAt > this.maxAge) {
            return undefined;
        }
        const labels = context.actionLabels;
        if (!labels) {
            return undefined;
        }
        let key = actionValue;
        if (!Object.hasOwn(labels, key)) {
            try {
                const parsed = JSON.parse(key);
                if (typeof parsed === 'string') {
                    key = parsed;
                }
            }
            catch { /* A plain action value needs no decoding. */ }
        }
        return Object.hasOwn(labels, key) ? labels[key] : undefined;
    }
    /**
     * Get action prompts by chatId (returns the most recent context for a chat).
     *
     * This is a fallback lookup for card action callbacks where the real Feishu
     * messageId doesn't match the synthetic messageId used during registration.
     *
     * @param chatId - Chat ID to look up
     * @returns Action prompt map, or undefined if not found
     */
    getActionPromptsByChatId(chatId) {
        const messageIds = this.chatIdIndex.get(chatId);
        if (!messageIds || messageIds.length === 0) {
            return undefined;
        }
        // Return the most recent context (last in the array)
        for (let i = messageIds.length - 1; i >= 0; i--) {
            const context = this.contexts.get(messageIds[i]);
            if (context) {
                return context.actionPrompts;
            }
        }
        // All entries stale, clean up
        this.chatIdIndex.delete(chatId);
        this.actionValueIndex.delete(chatId);
        return undefined;
    }
    /**
     * Find action prompts by chatId that contain a specific actionValue.
     *
     * Uses an inverted index (actionValueIndex) for O(1) lookup instead of
     * iterating through all contexts. Falls back to linear scan if the
     * inverted index entry is stale (messageId not found in contexts).
     *
     * @param chatId - Chat ID to search
     * @param actionValue - The action value to look for
     * @returns Action prompt map containing the actionValue, or undefined
     */
    findActionPromptsByChatId(chatId, actionValue) {
        // Fast path: use inverted index for O(1) lookup
        const avMap = this.actionValueIndex.get(chatId);
        if (avMap) {
            const messageIds = avMap.get(actionValue);
            if (messageIds && messageIds.length > 0) {
                // Search from newest to oldest (array is oldest-first, so iterate in reverse)
                for (let i = messageIds.length - 1; i >= 0; i--) {
                    const context = this.contexts.get(messageIds[i]);
                    if (context) {
                        return context.actionPrompts;
                    }
                }
                // All entries stale — clean up
                avMap.delete(actionValue);
            }
        }
        // Slow path: linear scan through chatIdIndex (fallback for stale entries)
        const messageIds = this.chatIdIndex.get(chatId);
        if (!messageIds || messageIds.length === 0) {
            return undefined;
        }
        // Search from newest to oldest
        for (let i = messageIds.length - 1; i >= 0; i--) {
            const context = this.contexts.get(messageIds[i]);
            if (context && context.actionPrompts[actionValue]) {
                // Repair inverted index while we're at it
                if (avMap) {
                    const existing = avMap.get(actionValue) || [];
                    if (!existing.includes(messageIds[i])) {
                        existing.push(messageIds[i]);
                        avMap.set(actionValue, existing);
                    }
                }
                return context.actionPrompts;
            }
        }
        return undefined;
    }
    /**
     * Generate a prompt from an interaction using the registered template.
     *
     * Resolve only the registered card in its original chat. A shared action
     * value is not proof that another card represents the same user choice.
     * JSON-encoded strings are accepted only when no exact literal key exists.
     *
     * @param messageId - The card message ID (from Feishu callback)
     * @param chatId - The chat ID that must match the registered card
     * @param actionValue - The action value from the button/menu
     * @param actionText - The display text of the action (optional)
     * @param actionType - The type of action (button, select_static, etc.)
     * @param formData - Form data if the action includes form inputs
     * @returns The generated prompt or undefined if no template found
     */
    generatePrompt(messageId, chatId, actionValue, actionText, actionType, formData) {
        const context = this.contexts.get(messageId);
        if (!context || context.chatId !== chatId || Date.now() - context.createdAt > this.maxAge) {
            return undefined;
        }
        const prompts = context.actionPrompts;
        let resolvedActionValue = actionValue;
        if (!Object.hasOwn(prompts, resolvedActionValue)) {
            try {
                const decoded = JSON.parse(actionValue);
                if (typeof decoded === 'string') {
                    resolvedActionValue = decoded;
                }
            }
            catch { /* Plain action values need no decoding. */ }
        }
        // Never resolve inherited object properties as executable prompt templates.
        const template = Object.hasOwn(prompts, resolvedActionValue) ? prompts[resolvedActionValue] : undefined;
        if (!template) {
            logger.debug({ messageId, chatId, actionValue, availableActions: Object.keys(prompts) }, 'No prompt template found for action');
            return undefined;
        }
        // Replace placeholders in the template
        let prompt = template;
        // Replace {{actionText}} with provided text, or empty string if not provided
        // to avoid leaving raw template placeholders in the generated prompt.
        // Escape template placeholders in user-supplied values to prevent injection (#2247).
        prompt = prompt.replace(/\{\{actionText\}\}/g, escapeTemplatePlaceholders(actionText ?? ''));
        prompt = prompt.replace(/\{\{actionValue\}\}/g, escapeTemplatePlaceholders(resolvedActionValue));
        // Replace {{actionType}} with provided type, or empty string if not provided
        prompt = prompt.replace(/\{\{actionType\}\}/g, escapeTemplatePlaceholders(actionType ?? ''));
        if (formData) {
            for (const [key, value] of Object.entries(formData)) {
                const placeholder = new RegExp(`\\{\\{form\\.${key}\\}\\}`, 'g');
                prompt = prompt.replace(placeholder, escapeTemplatePlaceholders(String(value)));
            }
        }
        return prompt;
    }
    /**
     * Remove action prompts for a message.
     *
     * @param messageId - Message ID to unregister
     * @returns True if the context was found and removed
     */
    unregister(messageId) {
        const previous = this.snapshot();
        const context = this.contexts.get(messageId);
        const removed = this.contexts.delete(messageId);
        if (removed && context) {
            // Remove messageId from chatId index array
            const messageIds = this.chatIdIndex.get(context.chatId);
            if (messageIds) {
                const filtered = messageIds.filter((id) => id !== messageId);
                if (filtered.length === 0) {
                    this.chatIdIndex.delete(context.chatId);
                }
                else {
                    this.chatIdIndex.set(context.chatId, filtered);
                }
            }
            // Remove from inverted index
            this.removeFromActionValueIndex(context.chatId, messageId, context.actionPrompts);
            logger.debug({ messageId }, 'Action prompts unregistered');
        }
        if (removed) {
            this.persist(previous);
        }
        return removed;
    }
    /**
     * Clean up expired interactive contexts.
     *
     * @returns Number of contexts cleaned up
     */
    cleanupExpired() {
        const previous = this.snapshot();
        const now = Date.now();
        let cleaned = 0;
        const expiredChatEntries = new Map();
        for (const [messageId, context] of this.contexts) {
            if (now - context.createdAt > this.maxAge) {
                this.contexts.delete(messageId);
                // Track expired entries for batch chatId index cleanup
                const entries = expiredChatEntries.get(context.chatId) || [];
                entries.push(messageId);
                expiredChatEntries.set(context.chatId, entries);
                cleaned++;
            }
        }
        // Batch clean up chatId index and inverted index
        for (const [chatId, expiredIds] of expiredChatEntries) {
            const messageIds = this.chatIdIndex.get(chatId);
            if (messageIds) {
                const filtered = messageIds.filter((id) => !expiredIds.includes(id));
                if (filtered.length === 0) {
                    this.chatIdIndex.delete(chatId);
                    this.actionValueIndex.delete(chatId);
                }
                else {
                    this.chatIdIndex.set(chatId, filtered);
                    // Clean up inverted index for expired entries
                    const avMap = this.actionValueIndex.get(chatId);
                    if (avMap) {
                        for (const [actionValue, msgIds] of avMap) {
                            const filtered = msgIds.filter((id) => !expiredIds.includes(id));
                            if (filtered.length === 0) {
                                avMap.delete(actionValue);
                            }
                            else {
                                avMap.set(actionValue, filtered);
                            }
                        }
                        if (avMap.size === 0) {
                            this.actionValueIndex.delete(chatId);
                        }
                    }
                }
            }
        }
        if (cleaned > 0) {
            this.persist(previous);
            logger.debug({ count: cleaned }, 'Cleaned up expired interactive contexts');
        }
        return cleaned;
    }
    /**
     * Get the number of stored contexts.
     */
    get size() {
        return this.contexts.size;
    }
    /**
     * Clear all contexts and indexes.
     */
    clear() {
        const previous = this.snapshot();
        this.contexts.clear();
        this.chatIdIndex.clear();
        this.actionValueIndex.clear();
        this.persist(previous);
    }
}

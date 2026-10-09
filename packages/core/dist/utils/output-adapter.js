/**
 * ANSI color codes for terminal output.
 */
const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    blue: '\x1b[34m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
};
/**
 * Color mapping for message types.
 */
function getColorForMessageType(messageType) {
    switch (messageType) {
        case 'tool_use':
            return 'yellow';
        case 'tool_progress':
            return 'blue';
        case 'tool_result':
            return 'cyan';
        case 'error':
            return 'red';
        case 'status':
            return 'magenta';
        case 'result':
            return 'green';
        case 'notification':
            return 'dim';
        default:
            return 'reset';
    }
}
/**
 * Format text with ANSI color.
 */
function colorText(text, colorName) {
    return `${colors[colorName]}${text}${colors.reset}`;
}
/**
 * CLI output adapter - writes to console with colors.
 */
export class CLIOutputAdapter {
    lastMessageType = 'text';
    write(content, messageType = 'text') {
        // Add newline between different message types
        if (messageType !== this.lastMessageType && messageType !== 'text') {
            console.log('');
        }
        // Format and output message
        const colorName = getColorForMessageType(messageType);
        const formatted = colorText(content, colorName);
        process.stdout.write(formatted);
        // Add newline for non-text messages
        if (messageType !== 'text') {
            console.log('');
        }
        this.lastMessageType = messageType;
    }
    /**
     * Ensure final newline when done.
     */
    finalize() {
        if (this.lastMessageType !== 'text') {
            console.log('');
        }
        else {
            console.log('');
        }
    }
}
/**
 * Feishu output adapter - sends messages via WebSocket.
 * Handles throttling for progress messages.
 *
 * Tracks whether any user-facing message has been sent during a task.
 */
export class FeishuOutputAdapter {
    options;
    progressThrottleMap = new Map();
    throttleIntervalMs;
    messageSentFlag = false; // Track if any user message was sent
    constructor(options) {
        this.options = options;
        this.throttleIntervalMs = options.throttleIntervalMs ?? 2000;
    }
    /**
     * Check if any user message has been sent during this task.
     */
    hasSentMessage() {
        return this.messageSentFlag;
    }
    /**
     * Reset message tracking for a new task.
     */
    resetMessageTracking() {
        this.messageSentFlag = false;
    }
    /**
     * Check if a progress message should be throttled.
     */
    shouldSendProgress(toolName) {
        const key = `${this.options.chatId}:${toolName}`;
        const now = Date.now();
        const lastSent = this.progressThrottleMap.get(key);
        if (lastSent === undefined || now - lastSent >= this.throttleIntervalMs) {
            this.progressThrottleMap.set(key, now);
            return true;
        }
        return false;
    }
    /**
     * Clear throttle state for this chat (call when starting a new query).
     */
    clearThrottleState() {
        for (const key of this.progressThrottleMap.keys()) {
            if (key.startsWith(`${this.options.chatId}:`)) {
                this.progressThrottleMap.delete(key);
            }
        }
    }
    async write(content, messageType = 'text', _metadata) {
        // Skip empty or whitespace-only content
        const trimmedContent = content.trim();
        if (!trimmedContent) {
            return;
        }
        // Skip SDK completion messages (they create visual noise)
        if (messageType === 'result' && trimmedContent.startsWith('✅ Complete')) {
            return;
        }
        // Throttle progress messages
        if (messageType === 'tool_progress') {
            // Extract tool name from content if possible
            const toolMatch = content.match(/Using (\w+):/);
            const toolName = toolMatch ? toolMatch[1] : 'unknown';
            if (!this.shouldSendProgress(toolName)) {
                return; // Skip this message due to throttling
            }
        }
        // Send message directly
        await this.options.sendMessage(this.options.chatId, content);
        this.messageSentFlag = true;
    }
}

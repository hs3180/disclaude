/**
 * Command data normalization (Issue #3529).
 *
 * Converts raw CLI-style data `{ args }` (from Feishu message-handler)
 * into the typed data format expected by each command's handler.
 *
 * @module control/normalize
 */
/**
 * Normalize raw command data into the typed format for a given command type.
 *
 * Handles the conversion from CLI-style `{ args: ['use', 'my-project'] }`
 * to structured `{ subcommand: 'use', workingDir: 'my-project' }`.
 */
export function normalizeCommandData(type, rawData) {
    if (!rawData) {
        return undefined;
    }
    switch (type) {
        case 'project': {
            const args = rawData.args;
            const subcommand = rawData.subcommand ?? args?.[0] ?? 'info';
            const workingDir = rawData.workingDir ??
                (args && args.length >= 2 && args[0] === 'use' ? args.slice(1).join(' ') : undefined);
            return { subcommand, ...(workingDir ? { workingDir } : {}) };
        }
        case 'trigger': {
            const rawArgs = rawData.args;
            const mode = Array.isArray(rawArgs) ? rawArgs[0] : rawArgs;
            return { mode };
        }
        case 'reset': {
            // Issue #3696: parse --no-context flag
            const resetArgs = rawData.args;
            const argsList = Array.isArray(resetArgs) ? resetArgs : [];
            const skipContext = argsList.includes('--no-context');
            return skipContext ? { skipContext: true } : undefined;
        }
        case 'agent': {
            const args = Array.isArray(rawData.args) ? rawData.args : [];
            const subcommand = (args[0] ?? 'current').toLowerCase();
            return {
                subcommand,
                ...(args[1] ? { preset: args[1] } : {}),
            };
        }
        case 'steer': {
            const args = Array.isArray(rawData.args) ? rawData.args : [];
            return { prompt: args.join(' ').trim() || undefined };
        }
        default:
            return undefined;
    }
}
/**
 * Create a ControlCommand with normalized data from raw CLI input.
 *
 * Used by channels (Feishu message-handler) that receive `/command arg1 arg2` text
 * and need to produce a properly typed ControlCommand.
 */
export function createControlCommand(type, chatId, rawData, extra) {
    return {
        type,
        chatId,
        data: normalizeCommandData(type, rawData),
        ...extra,
    };
}

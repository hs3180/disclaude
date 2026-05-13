/**
 * Command data normalization (Issue #3529).
 *
 * Converts raw CLI-style data `{ args, rawText, senderOpenId }` (from Feishu message-handler)
 * into the typed data format expected by each command's handler.
 *
 * @module control/normalize
 */

import type { ControlCommand, ControlCommandType, CommandDataMap } from '../types/channel.js';

/**
 * Normalize raw command data into the typed format for a given command type.
 *
 * Handles the conversion from CLI-style `{ args: ['use', 'my-project'] }`
 * to structured `{ subcommand: 'use', workingDir: 'my-project' }`.
 */
export function normalizeCommandData<T extends ControlCommandType>(
  type: T,
  rawData: Record<string, unknown> | undefined,
): CommandDataMap[keyof CommandDataMap] | undefined {
  if (!rawData) {return undefined;}

  switch (type) {
    case 'project': {
      const args = rawData.args as string[] | undefined;
      const subcommand = (rawData.subcommand as string) ?? args?.[0] ?? 'info';

      // For 'use': second arg is nameOrPath (backward compat: stored as workingDir)
      const workingDir = (rawData.workingDir as string) ??
        (args && args.length >= 2 && args[0] === 'use' ? args.slice(1).join(' ') : undefined);

      // For 'create': second arg is template, third is instance name
      const templateName = (rawData.templateName as string) ??
        (args && args.length >= 3 && args[0] === 'create' ? args[1] : undefined);
      const instanceName = (rawData.instanceName as string) ??
        (args && args.length >= 3 && args[0] === 'create' ? args[2] : undefined);

      return {
        subcommand,
        ...(workingDir ? { workingDir } : {}),
        ...(templateName ? { templateName } : {}),
        ...(instanceName ? { instanceName } : {}),
      };
    }
    case 'trigger': {
      const rawArgs = rawData.args;
      const mode = Array.isArray(rawArgs) ? rawArgs[0] as string : rawArgs as string | undefined;
      return { mode };
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
export function createControlCommand<T extends ControlCommandType>(
  type: T,
  chatId: string,
  rawData: Record<string, unknown> | undefined,
  extra?: { targetNodeId?: string },
): ControlCommand<T> {
  return {
    type,
    chatId,
    data: normalizeCommandData(type, rawData) as ControlCommand<T>['data'],
    ...extra,
  };
}

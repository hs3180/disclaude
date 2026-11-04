import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';
import { Config } from '../../config/index.js';
import { getProvider } from '../../sdk/factory.js';

/**
 * /status reports the running service without exposing execution-node roles.
 *
 * #5607: when the active agent backend's provider implements the optional
 * `getStatusExtra` capability (codex's weekly-quota ledger), its lines are
 * appended — labeled estimates, never account-truth. Provider construction
 * is the factory-cached singleton the service itself uses, so a /status
 * call never spawns anything new.
 */
export const handleStatus: CommandHandler = (
  _command: ControlCommand,
  _context: ControlHandlerContext
): ControlResponse => {
  const extra: string[] = [];
  try {
    extra.push(...(getProvider(Config.AGENT_BACKEND)?.getStatusExtra?.() ?? []));
  } catch {
    // Unknown/unavailable backend — /status still reports the service.
  }
  return {
    success: true,
    message: [
      '📊 **服务状态**',
      '',
      '**状态**: 🟢 运行中',
      ...(extra.length > 0 ? ['', ...extra] : []),
    ].join('\n'),
  };
};

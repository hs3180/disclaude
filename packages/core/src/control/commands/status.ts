import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /status reports the running service without exposing execution-node roles.
 */
export const handleStatus: CommandHandler = (
  _command: ControlCommand,
  _context: ControlHandlerContext
): ControlResponse => {
  return {
    success: true,
    message: [
      '📊 **服务状态**',
      '',
      '**状态**: 🟢 运行中',
    ].join('\n'),
  };
};

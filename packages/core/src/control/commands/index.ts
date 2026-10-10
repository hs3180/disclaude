import type { ControlCommandType, ControlCommand } from '../../types/channel.js';
import type { CommandDefinition, ControlHandlerContext } from '../types.js';
import { handleHelp } from './help.js';
import { handleStatus } from './status.js';
import { handleReset, handleRestart } from './reset.js';
import { handleStop } from './stop.js';
import { handleDebug } from './debug.js';
import { handleTrigger } from './passive.js';
import { handleProject } from './project.js';
import { handleAgent } from './agent.js';
import { handleSteer } from './steer.js';

/**
 * 命令注册表 (Issue #3529: typed per-command definitions)
 */
export const commandRegistry: CommandDefinition[] = [
  { type: 'help', handler: handleHelp, description: '显示帮助信息', usage: '/help [on|off]' },
  { type: 'status', handler: handleStatus, description: '查看服务状态' },
  { type: 'reset', handler: handleReset, description: '重置当前会话', usage: '/reset [--no-context]',
    isAvailable: (c, command) => !!c.agentPool?.reset && (!command.threadRootId || !!c.agentPool.resetThread) },
  { type: 'restart', handler: handleRestart, description: '重启整个服务进程', isAvailable: c => !!c.shutdown },
  { type: 'stop', handler: handleStop, description: '停止当前响应',
    isAvailable: (c, command) => !!c.agentPool?.stop && (!command.threadRootId || !!c.agentPool.stopThread) },
  { type: 'debug', handler: handleDebug, description: '切换 Debug 群设置', isAvailable: c => !!c.debugGroups },
  { type: 'trigger', handler: handleTrigger as CommandDefinition['handler'], description: '切换触发模式', usage: '/trigger [mention|always|auto]',
    isAvailable: (c, command) => !!c.triggerMode && command.chatType !== 'p2p' },
  { type: 'project', handler: handleProject as CommandDefinition['handler'], description: '项目管理命令', usage: '/project [use|reset|info]', isAvailable: c => !!c.projectManager },
  { type: 'agent', handler: handleAgent as CommandDefinition['handler'], description: '查看或切换 backend/model 预设', usage: '/agent [current|list|use <name>]',
    isAvailable: c => !!c.agentPool?.listAgentPresets && !!c.agentPool.getActiveAgentPreset && !!c.agentPool.switchAgentPreset && c.agentPool.listAgentPresets().length > 0 },
  { type: 'steer', handler: handleSteer as CommandDefinition['handler'], description: '运行中纠偏（需原生 turn/steer 支持）', usage: '/steer <instruction>',
    isAvailable: c => !!c.agentPool?.steer,
    showInHelp: (c, command) => c.agentPool.canSteer?.(command.chatId, command.threadRootId) === true },
];

export function getAvailableCommands(context: ControlHandlerContext, command: ControlCommand): CommandDefinition[] {
  return commandRegistry.filter(def =>
    (!def.isAvailable || def.isAvailable(context, { ...command, type: def.type })) &&
    (!def.showInHelp || def.showInHelp(context, { ...command, type: def.type })) &&
    (!context.isCommandAllowed || context.isCommandAllowed({ ...command, type: def.type })));
}

/**
 * 获取命令处理函数
 */
export function getHandler(type: ControlCommandType) {
  const def = commandRegistry.find((c) => c.type === type);
  return def?.handler;
}

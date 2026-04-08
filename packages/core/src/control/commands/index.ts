import type { ControlCommandType } from '../../types/channel.js';
import type { CommandDefinition } from '../types.js';
import { handleHelp } from './help.js';
import { handleStatus } from './status.js';
import { handleReset, handleRestart } from './reset.js';
import { handleStop } from './stop.js';
import { handleListNodes } from './list-nodes.js';
import { handleShowDebug, handleClearDebug } from './debug.js';
import { handlePassive } from './passive.js';

/**
 * 命令注册表
 */
export const commandRegistry: CommandDefinition[] = [
  { type: 'help', handler: handleHelp, description: '显示帮助信息' },
  { type: 'status', handler: handleStatus, description: '查看服务状态' },
  { type: 'reset', handler: handleReset, description: '重置当前会话' },
  { type: 'restart', handler: handleRestart, description: '重启 Agent 实例' },
  { type: 'stop', handler: handleStop, description: '停止当前响应' },
  { type: 'list-nodes', handler: handleListNodes, description: '查看执行节点' },
  { type: 'show-debug', handler: handleShowDebug, description: '显示 Debug 组' },
  { type: 'clear-debug', handler: handleClearDebug, description: '清除 Debug 组' },
  { type: 'passive', handler: handlePassive, description: '切换被动模式' },
];

/**
 * 获取命令处理函数
 */
export function getHandler(type: ControlCommandType) {
  const def = commandRegistry.find((c) => c.type === type);
  return def?.handler;
}

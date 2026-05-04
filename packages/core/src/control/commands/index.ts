import type { ControlCommandType } from '../../types/channel.js';
import type { CommandDefinition } from '../types.js';
import { handleHelp } from './help.js';
import { handleStatus } from './status.js';
import { handleReset, handleRestart } from './reset.js';
import { handleStop } from './stop.js';
import { handleListNodes } from './list-nodes.js';
import { handleDebug } from './debug.js';
import { handleTrigger } from './passive.js';
import { handleProject } from './project.js';

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
  { type: 'debug', handler: handleDebug, description: '切换 Debug 群设置' },
  { type: 'trigger', handler: handleTrigger, description: '切换触发模式', usage: '/trigger [mention|always]' },
  { type: 'project', handler: handleProject, description: '管理 Project 上下文', usage: '/project [list|create|use|info|reset]' },
];

/**
 * 获取命令处理函数
 */
export function getHandler(type: ControlCommandType) {
  const def = commandRegistry.find((c) => c.type === type);
  return def?.handler;
}

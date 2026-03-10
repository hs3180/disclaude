/**
 * Command Services Factory Module for PrimaryNode.
 *
 * Extracted from primary-node.ts (Issue #695) to improve maintainability.
 * Builds the CommandServices object for command execution context.
 *
 * Issue #463: 帮助消息系统
 * Issue #537: 完成所有指令的 DI 重构
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import {
  createDiscussionChat,
  dissolveChat,
  addMembers,
  removeMembers,
  getMembers,
  getBotChats,
} from '../platforms/feishu/chat-ops.js';
import type { GroupService } from '../platforms/feishu/group-service.js';
import type { TaskStateManager } from '../utils/task-state-manager.js';
import type { ExecNodeRegistry, DebugGroupService } from '@disclaude/primary-node';
import type { ScheduleManagement } from './schedule-management.js';
import type { SkillAgentManager } from '../agents/skill-agent-manager.js';
import type { CommandServices, ManagedGroupInfo, StartSkillAgentOptions } from './commands/types.js';

/**
 * Dependencies needed for building command services.
 */
export interface CommandServicesDeps {
  /** Check if the node is running */
  isRunning: () => boolean;
  /** Get the local node ID */
  getLocalNodeId: () => string;
  /** Execution node registry */
  execNodeRegistry: ExecNodeRegistry;
  /** Send command to execution node */
  sendCommand: (command: 'reset' | 'restart', chatId: string, options?: { keepContext?: boolean }) => Promise<void>;
  /** Get Feishu client */
  getFeishuClient: () => lark.Client;
  /** Group service */
  groupService: GroupService;
  /** Debug group service */
  debugGroupService: DebugGroupService;
  /** Schedule management */
  scheduleManagement: ScheduleManagement;
  /** Task state manager */
  taskStateManager: TaskStateManager;
  /** Get channel status list */
  getChannelStatus: () => string;
  /** Get channels for passive mode operations */
  getChannels: () => Array<{ id: string; name: string; setPassiveModeDisabled?: (chatId: string, disabled: boolean) => void; isPassiveModeDisabled?: (chatId: string) => boolean }>;
  /** Skill agent manager (Issue #455) */
  skillAgentManager: SkillAgentManager;
}

/**
 * Build CommandServices object from dependencies.
 *
 * This factory function creates the services object that is injected
 * into command execution context.
 */
export function buildCommandServices(deps: CommandServicesDeps): CommandServices {
  const {
    isRunning,
    getLocalNodeId,
    execNodeRegistry,
    sendCommand,
    getFeishuClient,
    groupService,
    debugGroupService,
    scheduleManagement,
    taskStateManager,
    getChannelStatus,
    getChannels,
    skillAgentManager,
  } = deps;

  return {
    // Node status
    isRunning,
    getLocalNodeId,

    // Execution node management
    getExecNodes: () => execNodeRegistry.getNodes(),
    getChatNodeAssignment: (chatId: string) => execNodeRegistry.getChatNodeAssignment(chatId),
    switchChatNode: (chatId: string, targetNodeId: string) => execNodeRegistry.switchChatNode(chatId, targetNodeId),
    getNode: (nodeId: string) => execNodeRegistry.getNode(nodeId),
    sendCommand,

    // Feishu client
    getFeishuClient,

    // Chat operations
    createDiscussionChat,
    addMembers,
    removeMembers,
    getMembers,
    dissolveChat,
    getBotChats,

    // Group management
    registerGroup: (group: ManagedGroupInfo) => groupService.registerGroup(group),
    unregisterGroup: (chatId: string) => groupService.unregisterGroup(chatId),
    listGroups: () => groupService.listGroups(),
    createGroup: (client: lark.Client, options: { topic?: string; members?: string[]; creatorId?: string }) =>
      groupService.createGroup(client, options),

    // Debug group
    setDebugGroup: (chatId: string, name?: string) => debugGroupService.setDebugGroup(chatId, name),
    getDebugGroup: () => debugGroupService.getDebugGroup(),
    clearDebugGroup: () => debugGroupService.clearDebugGroup(),

    // Channel status
    getChannelStatus,

    // Schedule management
    listSchedules: () => scheduleManagement.listSchedules(),
    getSchedule: (nameOrId: string) => scheduleManagement.getSchedule(nameOrId),
    enableSchedule: (nameOrId: string) => scheduleManagement.enableSchedule(nameOrId),
    disableSchedule: (nameOrId: string) => scheduleManagement.disableSchedule(nameOrId),
    runSchedule: (nameOrId: string) => scheduleManagement.runSchedule(nameOrId),
    isScheduleRunning: (taskId: string) => scheduleManagement.isScheduleRunning(taskId),
    getScheduleCooldownStatus: (taskId: string, cooldownPeriod?: number) => scheduleManagement.getScheduleCooldownStatus(taskId, cooldownPeriod),
    clearScheduleCooldown: (taskId: string) => scheduleManagement.clearScheduleCooldown(taskId),

    // Task management
    startTask: (prompt: string, chatId: string, userId?: string) => taskStateManager.startTask(prompt, chatId, userId),
    getCurrentTask: () => taskStateManager.getCurrentTask(),
    updateTaskProgress: (progress: number, currentStep?: string) => taskStateManager.updateProgress(progress, currentStep),
    pauseTask: () => taskStateManager.pauseTask(),
    resumeTask: () => taskStateManager.resumeTask(),
    cancelTask: () => taskStateManager.cancelTask(),
    completeTask: () => taskStateManager.completeTask(),
    setTaskError: (error: string) => taskStateManager.setTaskError(error),
    listTaskHistory: (limit?: number) => taskStateManager.listTaskHistory(limit),

    // Passive mode management
    setPassiveMode: (chatId: string, disabled: boolean) => {
      const feishuChannel = getChannels().find(c => c.name === 'Feishu');
      if (feishuChannel && feishuChannel.setPassiveModeDisabled) {
        feishuChannel.setPassiveModeDisabled(chatId, disabled);
      }
    },
    getPassiveMode: (chatId: string) => {
      const feishuChannel = getChannels().find(c => c.name === 'Feishu');
      if (feishuChannel && feishuChannel.isPassiveModeDisabled) {
        return feishuChannel.isPassiveModeDisabled(chatId);
      }
      return false; // Default: passive mode enabled (only @mention)
    },

    // Topic group management
    markAsTopicGroup: (chatId: string, isTopic: boolean) => groupService.markAsTopicGroup(chatId, isTopic),
    isTopicGroup: (chatId: string) => groupService.isTopicGroup(chatId),
    listTopicGroups: () => groupService.listTopicGroups(),

    // Skill Agent management (Issue #455)
    startSkillAgent: (options: StartSkillAgentOptions) => skillAgentManager.start(options),
    stopSkillAgent: (agentId: string) => skillAgentManager.stop(agentId),
    getSkillAgent: (agentId: string) => skillAgentManager.get(agentId),
    listSkillAgents: () => skillAgentManager.list(),
    stopAllSkillAgents: async () => {
      const count = skillAgentManager.listRunning().length;
      await skillAgentManager.stopAll();
      return count;
    },
  };
}

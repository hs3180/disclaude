/**
 * Modes module — Agent mode management.
 *
 * Issue #1709: 增加 Research 模式：SOUL + 工作目录 + Skill 套装切换
 *
 * @module modes
 */

export {
  type AgentMode,
  type ResearchState,
  type ResearchModeManagerOptions,
  sanitizeTopicName,
  ResearchModeManager,
} from './agent-mode.js';

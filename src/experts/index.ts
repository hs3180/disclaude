/**
 * Expert module exports.
 *
 * @see Issue #535 - 人类专家注册与技能声明
 * @see Issue #538 - 积分系统
 */

export {
  ExpertService,
  getExpertService,
  type ExpertProfile,
  type SkillDeclaration,
  type SkillLevel,
  type ExpertServiceConfig,
  type AgentAccount,
  type CreditTransaction,
} from './expert-service.js';

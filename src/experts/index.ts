/**
 * Expert module exports.
 *
 * @see Issue #535 - 人类专家注册与技能声明
 * @see Issue #538 - 积分系统 - 身价与消费
 */

export {
  ExpertService,
  getExpertService,
  type ExpertProfile,
  type SkillDeclaration,
  type SkillLevel,
  type ExpertServiceConfig,
} from './expert-service.js';

export {
  CreditService,
  getCreditService,
  type AgentAccount,
  type CreditTransaction,
  type CreditServiceConfig,
  type SpendResult,
} from './credit-service.js';

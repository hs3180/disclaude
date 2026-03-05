/**
 * Expert System Module.
 *
 * @see Issue #535 - 人类专家注册与技能声明
 * @see Issue #536 - 专家查询与匹配
 * @see Issue #538 - 积分系统 - 身价与消费
 */

export { ExpertService, getExpertService } from './expert-service.js';
export { BudgetService, getBudgetService } from './budget-service.js';
export type {
  Skill,
  SkillLevel,
  Availability,
  ExpertProfile,
  ExpertRegistry,
  AddSkillOptions,
  RemoveSkillOptions,
  SetAvailabilityOptions,
  FindExpertsOptions,
  ExpertMatch,
  SetPriceOptions,
  AgentAccount,
  BudgetRegistry,
  RechargeOptions,
  SetDailyLimitOptions,
  DeductCreditsOptions,
  DeductResult,
} from './types.js';

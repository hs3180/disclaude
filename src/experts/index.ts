/**
 * Expert module exports.
 *
 * @see Issue #535 - 人类专家注册与技能声明
 * @see Issue #536 - 专家查询与匹配
 * @see Issue #538 - 积分系统 - 身价与消费
 */

export {
  ExpertService,
  getExpertService,
  isAvailabilityMatch,
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
  type BillingResult,
} from './credit-service.js';

/**
 * Find experts by skill - convenience function for Agent use.
 *
 * @param skill - Skill name to search for
 * @param options - Search options
 * @returns Promise resolving to array of matching expert profiles
 * @see Issue #536 - 专家查询与匹配
 */
export async function findExperts(
  skill: string,
  options?: {
    minLevel?: number;
    available?: boolean;
    limit?: number;
  }
): Promise<import('./expert-service.js').ExpertProfile[]> {
  const { getExpertService } = await import('./expert-service.js');
  return getExpertService().findExperts(skill, options);
}

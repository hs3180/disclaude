/**
 * Expert System Module.
 *
 * @see Issue #535 - 人类专家注册与技能声明
 * @see Issue #536 - 专家查询与匹配
 */

export { ExpertService, getExpertService } from './expert-service.js';
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
} from './types.js';

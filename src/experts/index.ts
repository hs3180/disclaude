/**
 * Expert System Module.
 *
 * @see Issue #535 - 人类专家注册与技能声明
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
} from './types.js';

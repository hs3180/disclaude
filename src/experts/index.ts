/**
 * Expert module exports.
 *
 * @see Issue #535 - 人类专家注册与技能声明
 * @see Issue #536 - 专家查询与匹配
 */

export {
  ExpertService,
  getExpertService,
  type ExpertProfile,
  type SkillDeclaration,
  type SkillLevel,
  type ExpertServiceConfig,
  type FindExpertsOptions,
} from './expert-service.js';

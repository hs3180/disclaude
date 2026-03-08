/**
 * Tests for Expert MCP Tools.
 *
 * @see Issue #536 - 专家查询与匹配
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the expert-service module before any imports
const mockSearchBySkill = vi.fn();
const mockListExperts = vi.fn();

vi.mock('../../experts/expert-service.js', () => ({
  ExpertService: vi.fn(),
  getExpertService: vi.fn(() => ({
    searchBySkill: mockSearchBySkill,
    listExperts: mockListExperts,
  })),
}));

// Import after mock
import { checkAvailability, find_experts, list_experts } from './expert-tools.js';

describe('checkAvailability', () => {
  it('should return true for undefined availability', () => {
    expect(checkAvailability(undefined)).toBe(true);
  });

  it('should return true for "always" patterns', () => {
    expect(checkAvailability('always')).toBe(true);
    expect(checkAvailability('anytime')).toBe(true);
    expect(checkAvailability('全天')).toBe(true);
    expect(checkAvailability('随时')).toBe(true);
  });

  it('should return true for unparseable patterns', () => {
    expect(checkAvailability('some random text')).toBe(true);
  });
});

describe('find_experts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return error for empty skill', () => {
    const result = find_experts({ skill: '' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('请提供');
  });

  it('should find experts by skill', () => {
    mockSearchBySkill.mockReturnValue([
      {
        userId: 'user_1',
        name: 'TypeScript Expert',
        skills: [{ name: 'TypeScript', level: 5, tags: ['frontend'] }],
        availability: 'always',
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    const result = find_experts({ skill: 'TypeScript' });

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.experts[0].name).toBe('TypeScript Expert');
    expect(result.experts[0].matchingSkills).toHaveLength(1);
  });

  it('should filter by minimum level', () => {
    mockSearchBySkill.mockImplementation((_skill: string, minLevel?: number) => {
      const experts = [
        {
          userId: 'user_1',
          name: 'Senior',
          skills: [{ name: 'TypeScript', level: 5 }],
          registeredAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          userId: 'user_2',
          name: 'Junior',
          skills: [{ name: 'TypeScript', level: 2 }],
          registeredAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];
      if (minLevel !== undefined) {
        return experts.filter(e => e.skills.some((s: { level: number }) => s.level >= minLevel));
      }
      return experts;
    });

    const result = find_experts({ skill: 'TypeScript', minLevel: 4 });

    expect(result.count).toBe(1);
    expect(result.experts[0].name).toBe('Senior');
  });

  it('should return empty when no matches', () => {
    mockSearchBySkill.mockReturnValue([]);

    const result = find_experts({ skill: 'NonExistent' });

    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
    expect(result.experts).toEqual([]);
  });

  it('should apply limit', () => {
    mockSearchBySkill.mockReturnValue([
      { userId: 'user_1', name: 'Expert 1', skills: [{ name: 'TypeScript', level: 5 }], registeredAt: Date.now(), updatedAt: Date.now() },
      { userId: 'user_2', name: 'Expert 2', skills: [{ name: 'TypeScript', level: 4 }], registeredAt: Date.now(), updatedAt: Date.now() },
      { userId: 'user_3', name: 'Expert 3', skills: [{ name: 'TypeScript', level: 3 }], registeredAt: Date.now(), updatedAt: Date.now() },
    ]);

    const result = find_experts({ skill: 'TypeScript', limit: 2 });

    expect(result.count).toBe(2);
  });

  it('should filter by availability', () => {
    mockSearchBySkill.mockReturnValue([
      {
        userId: 'user_1',
        name: 'Always Available',
        skills: [{ name: 'TypeScript', level: 5 }],
        availability: 'always',
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        userId: 'user_2',
        name: 'Limited Availability',
        skills: [{ name: 'TypeScript', level: 4 }],
        availability: 'weekend 01:00-02:00',
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    const result = find_experts({ skill: 'TypeScript', availableOnly: true });

    expect(result.success).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(1);
    // All returned experts should be available
    for (const expert of result.experts) {
      expect(expert.isAvailable).toBe(true);
    }
  });

  it('should sort by skill level when both experts are available', () => {
    mockSearchBySkill.mockReturnValue([
      {
        userId: 'user_1',
        name: 'Junior',
        skills: [{ name: 'TypeScript', level: 2 }],
        availability: 'always',
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        userId: 'user_2',
        name: 'Senior',
        skills: [{ name: 'TypeScript', level: 5 }],
        availability: 'always',
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    const result = find_experts({ skill: 'TypeScript' });

    expect(result.count).toBe(2);
    // Both available, so sort by skill level (higher first)
    expect(result.experts[0].name).toBe('Senior');
    expect(result.experts[0].matchingSkills[0].level).toBe(5);
    expect(result.experts[1].name).toBe('Junior');
    expect(result.experts[1].matchingSkills[0].level).toBe(2);
  });
});

describe('list_experts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should list all experts', () => {
    mockListExperts.mockReturnValue([
      { userId: 'user_1', name: 'Expert 1', skills: [], registeredAt: Date.now(), updatedAt: Date.now() },
      { userId: 'user_2', name: 'Expert 2', skills: [], registeredAt: Date.now(), updatedAt: Date.now() },
    ]);

    const result = list_experts();

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
  });

  it('should return empty when no experts', () => {
    mockListExperts.mockReturnValue([]);

    const result = list_experts();

    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
  });

  it('should apply limit', () => {
    mockListExperts.mockReturnValue([
      { userId: 'user_1', name: 'Expert 1', skills: [], registeredAt: Date.now(), updatedAt: Date.now() },
      { userId: 'user_2', name: 'Expert 2', skills: [], registeredAt: Date.now(), updatedAt: Date.now() },
      { userId: 'user_3', name: 'Expert 3', skills: [], registeredAt: Date.now(), updatedAt: Date.now() },
    ]);

    const result = list_experts({ limit: 2 });

    expect(result.count).toBe(2);
  });
});

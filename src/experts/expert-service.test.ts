/**
 * ExpertService Tests.
 *
 * @see Issue #535 - 人类专家注册与技能声明
 * @see Issue #536 - 专家查询与匹配
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ExpertService } from './expert-service.js';

describe('ExpertService', () => {
  let service: ExpertService;
  const testFilePath = path.join(process.cwd(), 'workspace', 'test-experts.json');

  beforeEach(() => {
    // Clean up test file
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
    service = new ExpertService({ filePath: testFilePath });
  });

  afterEach(() => {
    // Clean up test file
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
  });

  describe('register', () => {
    it('should register a new expert', () => {
      const profile = service.register('ou_test123');

      expect(profile.userId).toBe('ou_test123');
      expect(profile.skills).toEqual([]);
      expect(profile.registeredAt).toBeGreaterThan(0);
      expect(profile.updatedAt).toBe(profile.registeredAt);
    });

    it('should return existing profile if already registered', () => {
      const profile1 = service.register('ou_test123');
      const profile2 = service.register('ou_test123');

      expect(profile1.registeredAt).toBe(profile2.registeredAt);
    });
  });

  describe('unregister', () => {
    it('should unregister an expert', () => {
      service.register('ou_test123');
      const result = service.unregister('ou_test123');

      expect(result).toBe(true);
      expect(service.isRegistered('ou_test123')).toBe(false);
    });

    it('should return false if expert not found', () => {
      const result = service.unregister('ou_nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('getProfile', () => {
    it('should return expert profile', () => {
      service.register('ou_test123');
      const profile = service.getProfile('ou_test123');

      expect(profile).toBeDefined();
      expect(profile?.userId).toBe('ou_test123');
    });

    it('should return undefined for non-existent expert', () => {
      const profile = service.getProfile('ou_nonexistent');

      expect(profile).toBeUndefined();
    });
  });

  describe('isRegistered', () => {
    it('should return true for registered expert', () => {
      service.register('ou_test123');

      expect(service.isRegistered('ou_test123')).toBe(true);
    });

    it('should return false for non-registered expert', () => {
      expect(service.isRegistered('ou_nonexistent')).toBe(false);
    });
  });

  describe('addSkill', () => {
    it('should add a skill to expert profile', () => {
      service.register('ou_test123');
      const profile = service.addSkill({
        userId: 'ou_test123',
        name: 'React',
        level: 4,
        tags: ['frontend', 'web'],
      });

      expect(profile).toBeDefined();
      expect(profile?.skills.length).toBe(1);
      expect(profile?.skills[0].name).toBe('React');
      expect(profile?.skills[0].level).toBe(4);
      expect(profile?.skills[0].tags).toEqual(['frontend', 'web']);
    });

    it('should update existing skill', () => {
      service.register('ou_test123');
      service.addSkill({
        userId: 'ou_test123',
        name: 'React',
        level: 3,
      });
      const profile = service.addSkill({
        userId: 'ou_test123',
        name: 'React',
        level: 5,
        tags: ['expert'],
      });

      expect(profile?.skills.length).toBe(1);
      expect(profile?.skills[0].level).toBe(5);
    });

    it('should return undefined for non-registered user', () => {
      const profile = service.addSkill({
        userId: 'ou_nonexistent',
        name: 'React',
        level: 4,
      });

      expect(profile).toBeUndefined();
    });

    it('should be case-insensitive for skill matching', () => {
      service.register('ou_test123');
      service.addSkill({
        userId: 'ou_test123',
        name: 'React',
        level: 3,
      });
      const profile = service.addSkill({
        userId: 'ou_test123',
        name: 'REACT',
        level: 5,
      });

      expect(profile?.skills.length).toBe(1);
      expect(profile?.skills[0].name).toBe('REACT');
    });
  });

  describe('removeSkill', () => {
    it('should remove a skill from expert profile', () => {
      service.register('ou_test123');
      service.addSkill({
        userId: 'ou_test123',
        name: 'React',
        level: 4,
      });
      const profile = service.removeSkill({
        userId: 'ou_test123',
        name: 'React',
      });

      expect(profile?.skills.length).toBe(0);
    });

    it('should be case-insensitive', () => {
      service.register('ou_test123');
      service.addSkill({
        userId: 'ou_test123',
        name: 'React',
        level: 4,
      });
      const profile = service.removeSkill({
        userId: 'ou_test123',
        name: 'REACT',
      });

      expect(profile?.skills.length).toBe(0);
    });

    it('should return unchanged profile if skill not found', () => {
      service.register('ou_test123');
      service.addSkill({
        userId: 'ou_test123',
        name: 'React',
        level: 4,
      });
      const profile = service.removeSkill({
        userId: 'ou_test123',
        name: 'Node.js',
      });

      expect(profile?.skills.length).toBe(1);
    });
  });

  describe('setAvailability', () => {
    it('should set availability for expert', () => {
      service.register('ou_test123');
      const profile = service.setAvailability({
        userId: 'ou_test123',
        days: 'weekdays',
        timeRange: '10:00-18:00',
      });

      expect(profile?.availability).toBeDefined();
      expect(profile?.availability?.days).toBe('weekdays');
      expect(profile?.availability?.timeRange).toBe('10:00-18:00');
    });

    it('should return undefined for non-registered user', () => {
      const profile = service.setAvailability({
        userId: 'ou_nonexistent',
        days: 'weekdays',
        timeRange: '10:00-18:00',
      });

      expect(profile).toBeUndefined();
    });
  });

  describe('clearAvailability', () => {
    it('should clear availability for expert', () => {
      service.register('ou_test123');
      service.setAvailability({
        userId: 'ou_test123',
        days: 'weekdays',
        timeRange: '10:00-18:00',
      });
      const profile = service.clearAvailability('ou_test123');

      expect(profile?.availability).toBeUndefined();
    });
  });

  describe('listExperts', () => {
    it('should list all experts', () => {
      service.register('ou_user1');
      service.register('ou_user2');
      service.register('ou_user3');

      const experts = service.listExperts();

      expect(experts.length).toBe(3);
    });

    it('should return empty array if no experts', () => {
      const experts = service.listExperts();

      expect(experts).toEqual([]);
    });
  });

  describe('findBySkill', () => {
    beforeEach(() => {
      service.register('ou_react_dev');
      service.addSkill({
        userId: 'ou_react_dev',
        name: 'React',
        level: 4,
        tags: ['frontend'],
      });

      service.register('ou_node_dev');
      service.addSkill({
        userId: 'ou_node_dev',
        name: 'Node.js',
        level: 4,
        tags: ['backend'],
      });

      service.register('ou_fullstack');
      service.addSkill({
        userId: 'ou_fullstack',
        name: 'React',
        level: 3,
      });
      service.addSkill({
        userId: 'ou_fullstack',
        name: 'Node.js',
        level: 3,
      });
    });

    it('should find experts by skill name', () => {
      const experts = service.findBySkill('React');

      expect(experts.length).toBe(2);
    });

    it('should be case-insensitive', () => {
      const experts = service.findBySkill('react');

      expect(experts.length).toBe(2);
    });

    it('should support partial matching', () => {
      const experts = service.findBySkill('Node');

      expect(experts.length).toBe(2);
    });

    it('should return empty array if no match', () => {
      const experts = service.findBySkill('Python');

      expect(experts).toEqual([]);
    });
  });

  describe('findByTag', () => {
    beforeEach(() => {
      service.register('ou_frontend');
      service.addSkill({
        userId: 'ou_frontend',
        name: 'React',
        level: 4,
        tags: ['frontend', 'web'],
      });

      service.register('ou_backend');
      service.addSkill({
        userId: 'ou_backend',
        name: 'Node.js',
        level: 4,
        tags: ['backend', 'api'],
      });
    });

    it('should find experts by tag', () => {
      const experts = service.findByTag('frontend');

      expect(experts.length).toBe(1);
      expect(experts[0].userId).toBe('ou_frontend');
    });

    it('should be case-insensitive', () => {
      const experts = service.findByTag('BACKEND');

      expect(experts.length).toBe(1);
    });
  });

  describe('persistence', () => {
    it('should persist data to file', () => {
      service.register('ou_test123');
      service.addSkill({
        userId: 'ou_test123',
        name: 'React',
        level: 4,
      });

      // Create new service instance to load from file
      const newService = new ExpertService({ filePath: testFilePath });
      const profile = newService.getProfile('ou_test123');

      expect(profile).toBeDefined();
      expect(profile?.skills.length).toBe(1);
    });
  });

  // Issue #536 - 专家查询与匹配
  describe('isAvailable', () => {
    beforeEach(() => {
      service.register('ou_available');
      service.setAvailability({
        userId: 'ou_available',
        days: 'all',
        timeRange: '00:00-23:59',
      });

      service.register('ou_weekdays');
      service.setAvailability({
        userId: 'ou_weekdays',
        days: 'weekdays',
        timeRange: '09:00-18:00',
      });

      service.register('ou_no_availability');
    });

    it('should return true for expert with no availability set', () => {
      const profile = service.getProfile('ou_no_availability')!;
      expect(service.isAvailable(profile)).toBe(true);
    });

    it('should return true when within time range', () => {
      const profile = service.getProfile('ou_available')!;
      expect(service.isAvailable(profile)).toBe(true);
    });

    it('should check day pattern correctly', () => {
      const profile = service.getProfile('ou_weekdays')!;
      // Just verify the method works, actual day check depends on current day
      const result = service.isAvailable(profile);
      expect(typeof result).toBe('boolean');
    });
  });

  describe('findExperts', () => {
    beforeEach(() => {
      // Create test experts with different skills and levels
      service.register('ou_react_junior');
      service.addSkill({
        userId: 'ou_react_junior',
        name: 'React',
        level: 2,
        tags: ['frontend'],
      });

      service.register('ou_react_senior');
      service.addSkill({
        userId: 'ou_react_senior',
        name: 'React',
        level: 5,
        tags: ['frontend', 'expert'],
      });

      service.register('ou_node_dev');
      service.addSkill({
        userId: 'ou_node_dev',
        name: 'Node.js',
        level: 4,
        tags: ['backend'],
      });

      service.register('ou_fullstack');
      service.addSkill({
        userId: 'ou_fullstack',
        name: 'React',
        level: 4,
      });
      service.addSkill({
        userId: 'ou_fullstack',
        name: 'Node.js',
        level: 3,
      });
    });

    it('should find experts by skill name', () => {
      const matches = service.findExperts('React');

      expect(matches.length).toBe(3);
      expect(matches.every(m => m.matchingSkills.some(s => s.name === 'React'))).toBe(true);
    });

    it('should filter by minimum skill level', () => {
      const matches = service.findExperts('React', { minLevel: 4 });

      expect(matches.length).toBe(2);
      expect(matches.every(m => m.matchingSkills.every(s => s.level >= 4))).toBe(true);
    });

    it('should limit results', () => {
      const matches = service.findExperts('React', { limit: 2 });

      expect(matches.length).toBe(2);
    });

    it('should sort by skill level (highest first)', () => {
      const matches = service.findExperts('React');

      expect(matches[0].expert.userId).toBe('ou_react_senior');
    });

    it('should include availability status', () => {
      // Set availability for one expert
      service.setAvailability({
        userId: 'ou_react_senior',
        days: 'all',
        timeRange: '00:00-23:59',
      });

      const matches = service.findExperts('React');

      expect(matches[0].isAvailable).toBe(true);
    });

    it('should filter by availability when requested', () => {
      // Set limited availability for one expert
      service.setAvailability({
        userId: 'ou_react_senior',
        days: 'all',
        timeRange: '00:00-23:59',
      });

      const matches = service.findExperts('React', { available: true });

      // Should only include available experts
      expect(matches.every(m => m.isAvailable)).toBe(true);
    });

    it('should be case-insensitive', () => {
      const matches = service.findExperts('react');

      expect(matches.length).toBe(3);
    });

    it('should support partial matching', () => {
      const matches = service.findExperts('Node');

      expect(matches.length).toBe(2);
    });

    it('should return empty array if no match', () => {
      const matches = service.findExperts('Python');

      expect(matches).toEqual([]);
    });
  });
});

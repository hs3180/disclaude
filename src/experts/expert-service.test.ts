/**
 * Tests for ExpertService.
 *
 * @see Issue #535 - 人类专家注册与技能声明
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ExpertService } from './expert-service.js';

describe('ExpertService', () => {
  let tempDir: string;
  let testFilePath: string;
  let service: ExpertService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expert-test-'));
    testFilePath = path.join(tempDir, 'experts.json');
    service = new ExpertService({ filePath: testFilePath });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('registerExpert', () => {
    it('should register a new expert', () => {
      const profile = service.registerExpert('user_123', 'John Doe');

      expect(profile.userId).toBe('user_123');
      expect(profile.name).toBe('John Doe');
      expect(profile.skills).toEqual([]);
      expect(profile.registeredAt).toBe(profile.updatedAt);
    });

    it('should update existing expert name', () => {
      service.registerExpert('user_123', 'John Doe');
      const profile = service.registerExpert('user_123', 'Jane Doe');

      expect(profile.name).toBe('Jane Doe');
      expect(profile.skills).toEqual([]);
    });
  });

  describe('getExpert', () => {
    it('should return undefined for non-existent expert', () => {
      expect(service.getExpert('nonexistent')).toBeUndefined();
    });

    it('should return expert profile', () => {
      service.registerExpert('user_123', 'John Doe');
      const profile = service.getExpert('user_123');

      expect(profile?.name).toBe('John Doe');
    });
  });

  describe('isExpert', () => {
    it('should return false for non-expert', () => {
      expect(service.isExpert('nonexistent')).toBe(false);
    });

    it('should return true for registered expert', () => {
      service.registerExpert('user_123', 'John Doe');
      expect(service.isExpert('user_123')).toBe(true);
    });
  });

  describe('listExperts', () => {
    it('should return empty array when no experts', () => {
      expect(service.listExperts()).toEqual([]);
    });

    it('should return all experts', () => {
      service.registerExpert('user_1', 'Expert 1');
      service.registerExpert('user_2', 'Expert 2');

      const experts = service.listExperts();
      expect(experts).toHaveLength(2);
      expect(experts.map(e => e.name)).toContain('Expert 1');
      expect(experts.map(e => e.name)).toContain('Expert 2');
    });
  });

  describe('addSkill', () => {
    it('should add skill to expert', () => {
      service.registerExpert('user_123', 'John Doe');
      const profile = service.addSkill('user_123', {
        name: 'TypeScript',
        level: 4,
        tags: ['frontend', 'web'],
      });

      expect(profile?.skills).toHaveLength(1);
      expect(profile?.skills[0].name).toBe('TypeScript');
      expect(profile?.skills[0].level).toBe(4);
    });

    it('should update existing skill', () => {
      service.registerExpert('user_123', 'John Doe');
      service.addSkill('user_123', { name: 'TypeScript', level: 3 });
      const profile = service.addSkill('user_123', { name: 'TypeScript', level: 5 });

      expect(profile?.skills).toHaveLength(1);
      expect(profile?.skills[0].level).toBe(5);
    });

    it('should return undefined for non-existent expert', () => {
      const result = service.addSkill('nonexistent', { name: 'TypeScript', level: 3 });
      expect(result).toBeUndefined();
    });
  });

  describe('removeSkill', () => {
    it('should remove skill from expert', () => {
      service.registerExpert('user_123', 'John Doe');
      service.addSkill('user_123', { name: 'TypeScript', level: 4 });
      service.addSkill('user_123', { name: 'React', level: 3 });

      const profile = service.removeSkill('user_123', 'TypeScript');

      expect(profile?.skills).toHaveLength(1);
      expect(profile?.skills[0].name).toBe('React');
    });

    it('should return undefined if skill not found', () => {
      service.registerExpert('user_123', 'John Doe');
      service.addSkill('user_123', { name: 'TypeScript', level: 4 });

      const result = service.removeSkill('user_123', 'Python');

      expect(result).toBeUndefined();
    });
  });

  describe('setAvailability', () => {
    it('should set availability for expert', () => {
      service.registerExpert('user_123', 'John Doe');
      const profile = service.setAvailability('user_123', 'weekdays 10:00-18:00');

      expect(profile?.availability).toBe('weekdays 10:00-18:00');
    });

    it('should return undefined for non-existent expert', () => {
      const result = service.setAvailability('nonexistent', 'weekdays');
      expect(result).toBeUndefined();
    });
  });

  describe('searchBySkill', () => {
    beforeEach(() => {
      service.registerExpert('user_1', 'Expert 1');
      service.registerExpert('user_2', 'Expert 2');
      service.registerExpert('user_3', 'Expert 3');

      service.addSkill('user_1', { name: 'TypeScript', level: 5, tags: ['frontend'] });
      service.addSkill('user_1', { name: 'React', level: 4, tags: ['frontend'] });

      service.addSkill('user_2', { name: 'Python', level: 4, tags: ['backend'] });
      service.addSkill('user_2', { name: 'TypeScript', level: 3, tags: ['backend'] });

      service.addSkill('user_3', { name: 'Go', level: 5, tags: ['backend'] });
    });

    it('should find experts by skill name', () => {
      const experts = service.searchBySkill('TypeScript');

      expect(experts).toHaveLength(2);
      expect(experts.map(e => e.name)).toContain('Expert 1');
      expect(experts.map(e => e.name)).toContain('Expert 2');
    });

    it('should filter by minimum level', () => {
      const experts = service.searchBySkill('TypeScript', 4);

      expect(experts).toHaveLength(1);
      expect(experts[0].name).toBe('Expert 1');
    });

    it('should find experts by tag', () => {
      const experts = service.searchBySkill('frontend');

      expect(experts).toHaveLength(1);
      expect(experts[0].name).toBe('Expert 1');
    });

    it('should return empty array if no match', () => {
      const experts = service.searchBySkill('Java');
      expect(experts).toEqual([]);
    });
  });

  describe('persistence', () => {
    it('should persist data to file', () => {
      service.registerExpert('user_123', 'John Doe');
      service.addSkill('user_123', { name: 'TypeScript', level: 4 });

      // Create new service instance to load from file
      const newService = new ExpertService({ filePath: testFilePath });
      const profile = newService.getExpert('user_123');

      expect(profile?.name).toBe('John Doe');
      expect(profile?.skills).toHaveLength(1);
      expect(profile?.skills[0].name).toBe('TypeScript');
    });
  });

  describe('unregisterExpert', () => {
    it('should unregister expert', () => {
      service.registerExpert('user_123', 'John Doe');
      const result = service.unregisterExpert('user_123');

      expect(result).toBe(true);
      expect(service.isExpert('user_123')).toBe(false);
    });

    it('should return false for non-existent expert', () => {
      const result = service.unregisterExpert('nonexistent');
      expect(result).toBe(false);
    });
  });
});

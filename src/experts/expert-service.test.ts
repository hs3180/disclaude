/**
 * Tests for ExpertService.
 *
 * @see Issue #535 - 人类专家注册与技能声明
 * @see Issue #538 - 积分系统
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

  // Credit System Tests (Issue #538)
  describe('setPrice', () => {
    it('should set price for expert', () => {
      service.registerExpert('user_123', 'John Doe');
      const profile = service.setPrice('user_123', 100);

      expect(profile?.price).toBe(100);
    });

    it('should return undefined for non-existent expert', () => {
      const result = service.setPrice('nonexistent', 100);
      expect(result).toBeUndefined();
    });

    it('should reject negative price', () => {
      service.registerExpert('user_123', 'John Doe');
      const result = service.setPrice('user_123', -10);

      expect(result).toBeUndefined();
    });

    it('should allow zero price (free consultation)', () => {
      service.registerExpert('user_123', 'John Doe');
      const profile = service.setPrice('user_123', 0);

      expect(profile?.price).toBe(0);
    });
  });

  describe('getOrCreateAccount', () => {
    it('should create new account', () => {
      const account = service.getOrCreateAccount('agent_001', 'Test Agent');

      expect(account.agentId).toBe('agent_001');
      expect(account.name).toBe('Test Agent');
      expect(account.balance).toBe(0);
      expect(account.dailyLimit).toBe(1000);
    });

    it('should return existing account', () => {
      service.getOrCreateAccount('agent_001', 'Test Agent');
      const account = service.getOrCreateAccount('agent_001', 'Updated Name');

      expect(account.name).toBe('Updated Name');
    });
  });

  describe('recharge', () => {
    it('should recharge account', () => {
      service.getOrCreateAccount('agent_001');
      const account = service.recharge('agent_001', 500);

      expect(account?.balance).toBe(500);
    });

    it('should reject non-positive amount', () => {
      service.getOrCreateAccount('agent_001');
      const account = service.recharge('agent_001', 0);

      expect(account).toBeUndefined();
    });

    it('should accumulate balance', () => {
      service.getOrCreateAccount('agent_001');
      service.recharge('agent_001', 500);
      const account = service.recharge('agent_001', 300);

      expect(account?.balance).toBe(800);
    });
  });

  describe('canAfford', () => {
    it('should return false for non-existent account', () => {
      expect(service.canAfford('nonexistent', 100)).toBe(false);
    });

    it('should return true when balance is sufficient', () => {
      service.getOrCreateAccount('agent_001');
      service.recharge('agent_001', 500);

      expect(service.canAfford('agent_001', 100)).toBe(true);
    });

    it('should return false when balance is insufficient', () => {
      service.getOrCreateAccount('agent_001');
      service.recharge('agent_001', 50);

      expect(service.canAfford('agent_001', 100)).toBe(false);
    });

    it('should return false when daily limit exceeded', () => {
      service.getOrCreateAccount('agent_001');
      service.recharge('agent_001', 1000);
      service.setDailyLimit('agent_001', 100);

      // Use 50 first
      service.registerExpert('expert_001', 'Expert');
      service.deductCredits('agent_001', 50, 'expert_001');

      // Try to use 60 more (would exceed limit)
      expect(service.canAfford('agent_001', 60)).toBe(false);
    });
  });

  describe('deductCredits', () => {
    it('should deduct credits from account', () => {
      service.getOrCreateAccount('agent_001');
      service.recharge('agent_001', 500);
      service.registerExpert('expert_001', 'Expert');

      const result = service.deductCredits('agent_001', 100, 'expert_001');

      expect(result?.account.balance).toBe(400);
      expect(result?.transaction.amount).toBe(-100);
    });

    it('should return undefined when balance insufficient', () => {
      service.getOrCreateAccount('agent_001');
      service.recharge('agent_001', 50);
      service.registerExpert('expert_001', 'Expert');

      const result = service.deductCredits('agent_001', 100, 'expert_001');

      expect(result).toBeUndefined();
    });

    it('should track daily usage', () => {
      service.getOrCreateAccount('agent_001');
      service.recharge('agent_001', 500);
      service.registerExpert('expert_001', 'Expert');

      service.deductCredits('agent_001', 100, 'expert_001');
      service.deductCredits('agent_001', 50, 'expert_001');

      const account = service.getAccount('agent_001');
      expect(account?.usedToday).toBe(150);
    });
  });

  describe('setDailyLimit', () => {
    it('should set daily limit', () => {
      service.getOrCreateAccount('agent_001');
      const account = service.setDailyLimit('agent_001', 500);

      expect(account?.dailyLimit).toBe(500);
    });

    it('should allow zero (unlimited)', () => {
      service.getOrCreateAccount('agent_001');
      const account = service.setDailyLimit('agent_001', 0);

      expect(account?.dailyLimit).toBe(0);
    });

    it('should reject negative limit', () => {
      service.getOrCreateAccount('agent_001');
      const account = service.setDailyLimit('agent_001', -10);

      expect(account).toBeUndefined();
    });
  });

  describe('refund', () => {
    it('should refund credits to account', () => {
      service.getOrCreateAccount('agent_001');
      service.recharge('agent_001', 100);

      const result = service.refund('agent_001', 50);

      expect(result?.account.balance).toBe(150);
      expect(result?.transaction.type).toBe('refund');
    });
  });

  describe('getTransactionHistory', () => {
    it('should return transaction history', () => {
      service.getOrCreateAccount('agent_001');
      service.recharge('agent_001', 500);
      service.registerExpert('expert_001', 'Expert');
      service.deductCredits('agent_001', 100, 'expert_001');

      const history = service.getTransactionHistory('agent_001');

      expect(history).toHaveLength(2);
      // Check that both transactions are present (order depends on timestamp)
      const types = history.map(t => t.type);
      expect(types).toContain('recharge');
      expect(types).toContain('deduct');
    });
  });

  describe('listAccounts', () => {
    it('should list all accounts', () => {
      service.getOrCreateAccount('agent_001');
      service.getOrCreateAccount('agent_002');

      const accounts = service.listAccounts();

      expect(accounts).toHaveLength(2);
    });
  });

  describe('credit persistence', () => {
    it('should persist account data to file', () => {
      service.getOrCreateAccount('agent_001');
      service.recharge('agent_001', 500);

      // Create new service instance to load from file
      const newService = new ExpertService({ filePath: testFilePath });
      const account = newService.getAccount('agent_001');

      expect(account?.balance).toBe(500);
    });

    it('should persist transaction history', () => {
      service.getOrCreateAccount('agent_001');
      service.recharge('agent_001', 500);

      // Create new service instance to load from file
      const newService = new ExpertService({ filePath: testFilePath });
      const history = newService.getTransactionHistory('agent_001');

      expect(history).toHaveLength(1);
      expect(history[0].type).toBe('recharge');
    });
  });
});

/**
 * BudgetService Tests.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BudgetService } from './budget-service.js';

describe('BudgetService', () => {
  let service: BudgetService;
  let testFilePath: string;

  beforeEach(() => {
    // Use a temp file for each test
    testFilePath = path.join(process.cwd(), `test-budget-${Date.now()}.json`);
    service = new BudgetService({ filePath: testFilePath });
  });

  afterEach(() => {
    // Clean up temp file
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
  });

  describe('getOrCreateAccount', () => {
    it('should create a new account with default values', () => {
      const account = service.getOrCreateAccount('agent-001');

      expect(account.agentId).toBe('agent-001');
      expect(account.balance).toBe(0);
      expect(account.dailyLimit).toBe(100);
      expect(account.usedToday).toBe(0);
    });

    it('should return existing account', () => {
      service.getOrCreateAccount('agent-001', 50, 200);
      const account = service.getOrCreateAccount('agent-001');

      expect(account.balance).toBe(50); // Not reset to default
    });

    it('should create account with custom initial values', () => {
      const account = service.getOrCreateAccount('agent-002', 100, 50);

      expect(account.balance).toBe(100);
      expect(account.dailyLimit).toBe(50);
    });
  });

  describe('getAccount', () => {
    it('should return undefined for non-existent account', () => {
      const account = service.getAccount('nonexistent');
      expect(account).toBeUndefined();
    });

    it('should return existing account', () => {
      service.getOrCreateAccount('agent-001');
      const account = service.getAccount('agent-001');
      expect(account).toBeDefined();
    });
  });

  describe('recharge', () => {
    it('should fail for non-existent account', () => {
      const result = service.recharge({ agentId: 'nonexistent', credits: 100 });
      expect(result).toBeUndefined();
    });

    it('should fail for invalid amount', () => {
      service.getOrCreateAccount('agent-001');
      const result = service.recharge({ agentId: 'agent-001', credits: 0 });
      expect(result).toBeUndefined();
    });

    it('should increase balance', () => {
      service.getOrCreateAccount('agent-001');
      const result = service.recharge({ agentId: 'agent-001', credits: 100 });

      expect(result).toBeDefined();
      expect(result!.balance).toBe(100);
    });

    it('should accumulate balance', () => {
      service.getOrCreateAccount('agent-001', 50);
      service.recharge({ agentId: 'agent-001', credits: 100 });
      const result = service.recharge({ agentId: 'agent-001', credits: 50 });

      expect(result!.balance).toBe(200);
    });
  });

  describe('setDailyLimit', () => {
    it('should fail for non-existent account', () => {
      const result = service.setDailyLimit({ agentId: 'nonexistent', dailyLimit: 50 });
      expect(result).toBeUndefined();
    });

    it('should update daily limit', () => {
      service.getOrCreateAccount('agent-001');
      const result = service.setDailyLimit({ agentId: 'agent-001', dailyLimit: 50 });

      expect(result).toBeDefined();
      expect(result!.dailyLimit).toBe(50);
    });
  });

  describe('deduct', () => {
    beforeEach(() => {
      service.getOrCreateAccount('agent-001', 100, 50);
    });

    it('should fail for non-existent account', () => {
      const result = service.deduct({ agentId: 'nonexistent', credits: 10 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('account_not_found');
    });

    it('should fail for insufficient balance', () => {
      const result = service.deduct({ agentId: 'agent-001', credits: 200 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('insufficient_balance');
    });

    it('should fail for exceeding daily limit', () => {
      const result = service.deduct({ agentId: 'agent-001', credits: 60 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('daily_limit_exceeded');
    });

    it('should deduct credits successfully', () => {
      const result = service.deduct({ agentId: 'agent-001', credits: 30 });

      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(70);
    });

    it('should track daily usage', () => {
      service.deduct({ agentId: 'agent-001', credits: 20 });
      service.deduct({ agentId: 'agent-001', credits: 10 });

      const account = service.getAccount('agent-001');
      expect(account!.usedToday).toBe(30);
    });
  });

  describe('canAfford', () => {
    beforeEach(() => {
      service.getOrCreateAccount('agent-001', 100, 50);
    });

    it('should return false for non-existent account', () => {
      expect(service.canAfford('nonexistent', 10)).toBe(false);
    });

    it('should return true when affordable', () => {
      expect(service.canAfford('agent-001', 30)).toBe(true);
    });

    it('should return false when balance insufficient', () => {
      expect(service.canAfford('agent-001', 200)).toBe(false);
    });

    it('should return false when daily limit exceeded', () => {
      expect(service.canAfford('agent-001', 60)).toBe(false);
    });
  });

  describe('listAccounts', () => {
    it('should return empty array when no accounts', () => {
      const accounts = service.listAccounts();
      expect(accounts).toHaveLength(0);
    });

    it('should return all accounts', () => {
      service.getOrCreateAccount('agent-001');
      service.getOrCreateAccount('agent-002');

      const accounts = service.listAccounts();
      expect(accounts).toHaveLength(2);
    });
  });

  describe('deleteAccount', () => {
    it('should return false for non-existent account', () => {
      expect(service.deleteAccount('nonexistent')).toBe(false);
    });

    it('should delete existing account', () => {
      service.getOrCreateAccount('agent-001');
      expect(service.deleteAccount('agent-001')).toBe(true);
      expect(service.getAccount('agent-001')).toBeUndefined();
    });
  });

  describe('persistence', () => {
    it('should persist data to file', () => {
      service.getOrCreateAccount('agent-001', 100, 50);
      service.recharge({ agentId: 'agent-001', credits: 50 });

      // Create new service instance with same file
      const newService = new BudgetService({ filePath: testFilePath });
      const account = newService.getAccount('agent-001');

      expect(account).toBeDefined();
      expect(account!.balance).toBe(150);
    });
  });
});

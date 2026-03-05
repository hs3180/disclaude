/**
 * CreditService Tests.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CreditService } from './credit-service.js';

describe('CreditService', () => {
  let service: CreditService;
  const testFilePath = path.join(process.cwd(), 'workspace', 'test-credits.json');

  beforeEach(() => {
    // Clean up test file
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
    service = new CreditService({ filePath: testFilePath });
  });

  afterEach(() => {
    // Clean up test file
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
  });

  describe('createAccount', () => {
    it('should create a new account with defaults', () => {
      const account = service.createAccount({ agentId: 'agent-1' });

      expect(account.agentId).toBe('agent-1');
      expect(account.balance).toBe(0);
      expect(account.dailyLimit).toBe(100);
      expect(account.usedToday).toBe(0);
      expect(account.createdAt).toBeGreaterThan(0);
    });

    it('should create account with custom values', () => {
      const account = service.createAccount({
        agentId: 'agent-1',
        initialBalance: 500,
        dailyLimit: 200,
      });

      expect(account.balance).toBe(500);
      expect(account.dailyLimit).toBe(200);
    });

    it('should return existing account if already exists', () => {
      const account1 = service.createAccount({ agentId: 'agent-1', initialBalance: 100 });
      const account2 = service.createAccount({ agentId: 'agent-1', initialBalance: 200 });

      expect(account1.createdAt).toBe(account2.createdAt);
      expect(account2.balance).toBe(100); // Should not change
    });
  });

  describe('getAccount', () => {
    it('should return account if exists', () => {
      service.createAccount({ agentId: 'agent-1' });
      const account = service.getAccount('agent-1');

      expect(account).toBeDefined();
      expect(account?.agentId).toBe('agent-1');
    });

    it('should return undefined if not found', () => {
      const account = service.getAccount('nonexistent');
      expect(account).toBeUndefined();
    });
  });

  describe('hasAccount', () => {
    it('should return true for existing account', () => {
      service.createAccount({ agentId: 'agent-1' });
      expect(service.hasAccount('agent-1')).toBe(true);
    });

    it('should return false for non-existing account', () => {
      expect(service.hasAccount('nonexistent')).toBe(false);
    });
  });

  describe('getOrCreateAccount', () => {
    it('should return existing account', () => {
      service.createAccount({ agentId: 'agent-1', initialBalance: 100 });
      const account = service.getOrCreateAccount('agent-1');

      expect(account.balance).toBe(100);
    });

    it('should create new account if not exists', () => {
      const account = service.getOrCreateAccount('agent-1');

      expect(account.agentId).toBe('agent-1');
      expect(account.balance).toBe(0);
    });
  });

  describe('recharge', () => {
    it('should add credits to account', () => {
      service.createAccount({ agentId: 'agent-1', initialBalance: 100 });
      const account = service.recharge({ agentId: 'agent-1', credits: 50 });

      expect(account?.balance).toBe(150);
    });

    it('should return undefined for non-existing account', () => {
      const account = service.recharge({ agentId: 'nonexistent', credits: 50 });
      expect(account).toBeUndefined();
    });
  });

  describe('setDailyLimit', () => {
    it('should update daily limit', () => {
      service.createAccount({ agentId: 'agent-1', dailyLimit: 100 });
      const account = service.setDailyLimit({ agentId: 'agent-1', dailyLimit: 200 });

      expect(account?.dailyLimit).toBe(200);
    });

    it('should return undefined for non-existing account', () => {
      const account = service.setDailyLimit({ agentId: 'nonexistent', dailyLimit: 200 });
      expect(account).toBeUndefined();
    });
  });

  describe('deduct', () => {
    it('should deduct credits successfully', () => {
      service.createAccount({ agentId: 'agent-1', initialBalance: 100 });
      const result = service.deduct({ agentId: 'agent-1', credits: 30 });

      expect(result.success).toBe(true);
      expect(result.remainingBalance).toBe(70);
    });

    it('should fail with insufficient balance', () => {
      service.createAccount({ agentId: 'agent-1', initialBalance: 50 });
      const result = service.deduct({ agentId: 'agent-1', credits: 100 });

      expect(result.success).toBe(false);
      expect(result.error).toBe('insufficient_balance');
      expect(result.remainingBalance).toBe(50);
    });

    it('should fail when daily limit exceeded', () => {
      service.createAccount({ agentId: 'agent-1', initialBalance: 200, dailyLimit: 50 });

      const result = service.deduct({ agentId: 'agent-1', credits: 60 });

      expect(result.success).toBe(false);
      expect(result.error).toBe('daily_limit_exceeded');
    });

    it('should track daily usage', () => {
      service.createAccount({ agentId: 'agent-1', initialBalance: 200, dailyLimit: 100 });

      service.deduct({ agentId: 'agent-1', credits: 30 });
      service.deduct({ agentId: 'agent-1', credits: 40 });

      const account = service.getAccount('agent-1');
      expect(account?.usedToday).toBe(70);
    });

    it('should fail if daily limit reached', () => {
      service.createAccount({ agentId: 'agent-1', initialBalance: 200, dailyLimit: 100 });

      service.deduct({ agentId: 'agent-1', credits: 60 });
      const result = service.deduct({ agentId: 'agent-1', credits: 50 });

      expect(result.success).toBe(false);
      expect(result.error).toBe('daily_limit_exceeded');
    });

    it('should fail for non-existing account', () => {
      const result = service.deduct({ agentId: 'nonexistent', credits: 10 });

      expect(result.success).toBe(false);
      expect(result.error).toBe('account_not_found');
    });
  });

  describe('listAccounts', () => {
    it('should return all accounts', () => {
      service.createAccount({ agentId: 'agent-1' });
      service.createAccount({ agentId: 'agent-2' });

      const accounts = service.listAccounts();

      expect(accounts.length).toBe(2);
      expect(accounts.map((a) => a.agentId)).toContain('agent-1');
      expect(accounts.map((a) => a.agentId)).toContain('agent-2');
    });

    it('should return empty array if no accounts', () => {
      const accounts = service.listAccounts();
      expect(accounts).toEqual([]);
    });
  });

  describe('deleteAccount', () => {
    it('should delete existing account', () => {
      service.createAccount({ agentId: 'agent-1' });
      const result = service.deleteAccount('agent-1');

      expect(result).toBe(true);
      expect(service.hasAccount('agent-1')).toBe(false);
    });

    it('should return false for non-existing account', () => {
      const result = service.deleteAccount('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('persistence', () => {
    it('should persist data to file', () => {
      service.createAccount({ agentId: 'agent-1', initialBalance: 100 });
      service.recharge({ agentId: 'agent-1', credits: 50 });

      // Create new service instance to load from file
      const newService = new CreditService({ filePath: testFilePath });
      const account = newService.getAccount('agent-1');

      expect(account?.balance).toBe(150);
    });
  });

  describe('daily reset', () => {
    it('should reset usedToday when new day starts', () => {
      // Create account with some usage
      service.createAccount({ agentId: 'agent-1', initialBalance: 200, dailyLimit: 100 });
      service.deduct({ agentId: 'agent-1', credits: 50 });

      // Verify usage
      let account = service.getAccount('agent-1');
      expect(account?.usedToday).toBe(50);

      // Simulate new day by modifying lastResetAt
      const accountInternal = (service as unknown as { registry: { accounts: Record<string, unknown> } }).registry.accounts['agent-1'] as { lastResetAt: number; usedToday: number };
      accountInternal.lastResetAt = 0; // Set to past

      // Get account should trigger reset
      account = service.getAccount('agent-1');
      expect(account?.usedToday).toBe(0);
    });
  });
});

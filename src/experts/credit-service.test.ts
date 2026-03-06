/**
 * Tests for CreditService.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CreditService } from './credit-service.js';

describe('CreditService', () => {
  let tempDir: string;
  let testFilePath: string;
  let service: CreditService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'credit-test-'));
    testFilePath = path.join(tempDir, 'credits.json');
    service = new CreditService({
      filePath: testFilePath,
      initialBalance: 100,
      defaultDailyLimit: 50,
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  describe('getOrCreateAccount', () => {
    it('should create a new account with initial balance', () => {
      const account = service.getOrCreateAccount('agent_123');

      expect(account.agentId).toBe('agent_123');
      expect(account.balance).toBe(100);
      expect(account.dailyLimit).toBe(50);
      expect(account.usedToday).toBe(0);
    });

    it('should return existing account', () => {
      service.getOrCreateAccount('agent_123');
      const account = service.getOrCreateAccount('agent_123');

      expect(account.agentId).toBe('agent_123');
    });
  });

  describe('getAccount', () => {
    it('should return undefined for non-existent account', () => {
      expect(service.getAccount('nonexistent')).toBeUndefined();
    });

    it('should return existing account', () => {
      service.getOrCreateAccount('agent_123');
      const account = service.getAccount('agent_123');

      expect(account?.agentId).toBe('agent_123');
    });
  });

  describe('canSpend', () => {
    it('should return false for non-existent account', () => {
      expect(service.canSpend('nonexistent', 10)).toBe(false);
    });

    it('should return true when balance is sufficient', () => {
      service.getOrCreateAccount('agent_123');
      expect(service.canSpend('agent_123', 50)).toBe(true);
    });

    it('should return false when balance is insufficient', () => {
      service.getOrCreateAccount('agent_123');
      expect(service.canSpend('agent_123', 150)).toBe(false);
    });

    it('should return false when daily limit exceeded', () => {
      const account = service.getOrCreateAccount('agent_123');
      account.usedToday = 45; // Near limit
      expect(service.canSpend('agent_123', 10)).toBe(false);
    });

    it('should allow unlimited daily when limit is 0', () => {
      const account = service.getOrCreateAccount('agent_123');
      account.dailyLimit = 0;
      account.usedToday = 1000;
      expect(service.canSpend('agent_123', 10)).toBe(true);
    });
  });

  describe('spend', () => {
    it('should spend credits successfully', () => {
      service.getOrCreateAccount('agent_123');
      const result = service.spend('agent_123', 20, 'Consultation');

      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(80);

      const account = service.getAccount('agent_123');
      expect(account?.balance).toBe(80);
      expect(account?.usedToday).toBe(20);
    });

    it('should return error for non-existent account', () => {
      const result = service.spend('nonexistent', 10, 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('account_not_found');
    });

    it('should return error for insufficient balance', () => {
      service.getOrCreateAccount('agent_123');
      const result = service.spend('agent_123', 150, 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('insufficient_balance');
    });

    it('should return error for daily limit exceeded', () => {
      const account = service.getOrCreateAccount('agent_123');
      account.usedToday = 45;
      const result = service.spend('agent_123', 10, 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('daily_limit_exceeded');
    });

    it('should record transaction with expert ID', () => {
      service.getOrCreateAccount('agent_123');
      const result = service.spend('agent_123', 20, 'Consultation', 'expert_456');

      expect(result.success).toBe(true);
      expect(result.transaction?.expertId).toBe('expert_456');
      expect(result.transaction?.type).toBe('spend');
    });
  });

  describe('recharge', () => {
    it('should recharge credits', () => {
      service.getOrCreateAccount('agent_123');
      const account = service.recharge('agent_123', 50);

      expect(account?.balance).toBe(150);
    });

    it('should create account if not exists', () => {
      const account = service.recharge('agent_123', 50);

      expect(account?.agentId).toBe('agent_123');
      expect(account?.balance).toBe(150); // initial + recharge
    });

    it('should return undefined for invalid amount', () => {
      const result = service.recharge('agent_123', 0);
      expect(result).toBeUndefined();
    });

    it('should record recharge transaction', () => {
      service.recharge('agent_123', 50);
      const history = service.getTransactionHistory('agent_123');

      expect(history).toHaveLength(1);
      expect(history[0].type).toBe('recharge');
      expect(history[0].amount).toBe(50);
    });
  });

  describe('refund', () => {
    it('should refund credits', () => {
      service.getOrCreateAccount('agent_123');
      service.spend('agent_123', 20, 'Consultation');

      const account = service.refund('agent_123', 20, 'Refund');

      expect(account?.balance).toBe(100);
    });

    it('should reduce daily usage', () => {
      const account = service.getOrCreateAccount('agent_123');
      service.spend('agent_123', 20, 'Consultation');

      service.refund('agent_123', 20, 'Refund');

      expect(account.usedToday).toBe(0);
    });

    it('should return undefined for non-existent account', () => {
      const result = service.refund('nonexistent', 10, 'Refund');
      expect(result).toBeUndefined();
    });
  });

  describe('setDailyLimit', () => {
    it('should set daily limit', () => {
      service.getOrCreateAccount('agent_123');
      const account = service.setDailyLimit('agent_123', 100);

      expect(account?.dailyLimit).toBe(100);
    });

    it('should create account if not exists', () => {
      const account = service.setDailyLimit('agent_123', 100);

      expect(account?.agentId).toBe('agent_123');
    });

    it('should allow unlimited (0)', () => {
      service.getOrCreateAccount('agent_123');
      const account = service.setDailyLimit('agent_123', 0);

      expect(account?.dailyLimit).toBe(0);
    });

    it('should return undefined for negative limit', () => {
      service.getOrCreateAccount('agent_123');
      const result = service.setDailyLimit('agent_123', -10);

      expect(result).toBeUndefined();
    });
  });

  describe('listAccounts', () => {
    it('should return empty array when no accounts', () => {
      expect(service.listAccounts()).toEqual([]);
    });

    it('should return all accounts', () => {
      service.getOrCreateAccount('agent_1');
      service.getOrCreateAccount('agent_2');

      const accounts = service.listAccounts();
      expect(accounts).toHaveLength(2);
      expect(accounts.map(a => a.agentId)).toContain('agent_1');
      expect(accounts.map(a => a.agentId)).toContain('agent_2');
    });
  });

  describe('getTransactionHistory', () => {
    it('should return empty array for no transactions', () => {
      expect(service.getTransactionHistory('agent_123')).toEqual([]);
    });

    it('should return transaction history', () => {
      service.getOrCreateAccount('agent_123');
      service.spend('agent_123', 10, 'Test 1');
      service.recharge('agent_123', 20, 'Test 2');

      const history = service.getTransactionHistory('agent_123');
      expect(history).toHaveLength(2);
    });

    it('should limit results', () => {
      service.getOrCreateAccount('agent_123');
      for (let i = 0; i < 10; i++) {
        service.spend('agent_123', 1, `Test ${i}`);
      }

      const history = service.getTransactionHistory('agent_123', 5);
      expect(history).toHaveLength(5);
    });
  });

  describe('daily reset', () => {
    it('should reset daily usage on new day', () => {
      const account = service.getOrCreateAccount('agent_123');
      service.spend('agent_123', 20, 'Test');

      expect(account.usedToday).toBe(20);

      // Simulate new day
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-02'));

      const accountAfterReset = service.getAccount('agent_123');
      expect(accountAfterReset?.usedToday).toBe(0);
    });
  });

  describe('persistence', () => {
    it('should persist data to file', () => {
      service.getOrCreateAccount('agent_123');
      service.recharge('agent_123', 50);

      // Create new service instance to load from file
      const newService = new CreditService({ filePath: testFilePath });
      const account = newService.getAccount('agent_123');

      expect(account?.balance).toBe(150);
    });
  });
});

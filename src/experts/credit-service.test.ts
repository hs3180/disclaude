/**
 * Tests for CreditService.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CreditService, getCreditService } from './credit-service.js';

describe('CreditService', () => {
  let service: CreditService;
  let tempDir: string;
  let testFilePath: string;

  beforeEach(() => {
    // Create a temp file for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'credit-service-test-'));
    testFilePath = path.join(tempDir, 'credits.json');
    service = new CreditService({ filePath: testFilePath });
  });

  afterEach(() => {
    // Clean up temp files
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    // Reset singleton
    (getCreditService as any).defaultInstance = undefined;
  });

  describe('getOrCreateAccount', () => {
    it('should create a new account with default values', () => {
      const account = service.getOrCreateAccount('agent_1');

      expect(account.agentId).toBe('agent_1');
      expect(account.balance).toBe(100); // default balance
      expect(account.dailyLimit).toBe(1000); // default limit
      expect(account.usedToday).toBe(0);
    });

    it('should return existing account', () => {
      service.getOrCreateAccount('agent_1');
      service.recharge('agent_1', 500);

      const account = service.getOrCreateAccount('agent_1');
      expect(account.balance).toBe(600); // 100 + 500
    });
  });

  describe('recharge', () => {
    it('should add credits to account', () => {
      const account = service.recharge('agent_1', 500);

      // Default balance (100) + recharge (500) = 600
      expect(account.balance).toBe(600);
    });

    it('should add to existing balance', () => {
      service.recharge('agent_1', 500);
      const account = service.recharge('agent_1', 300);

      // 100 + 500 + 300 = 900
      expect(account.balance).toBe(900);
    });

    it('should record transaction', () => {
      service.recharge('agent_1', 500);
      const history = service.getTransactionHistory('agent_1');

      expect(history).toHaveLength(1);
      expect(history[0].type).toBe('recharge');
      expect(history[0].amount).toBe(500);
    });
  });

  describe('setDailyLimit', () => {
    it('should set daily limit', () => {
      service.getOrCreateAccount('agent_1');
      const account = service.setDailyLimit('agent_1', 500);

      expect(account?.dailyLimit).toBe(500);
    });

    it('should allow unlimited (0)', () => {
      service.getOrCreateAccount('agent_1');
      const account = service.setDailyLimit('agent_1', 0);

      expect(account?.dailyLimit).toBe(0);
    });

    it('should return undefined for non-existent account', () => {
      const account = service.setDailyLimit('nonexistent', 500);

      expect(account).toBeUndefined();
    });
  });

  describe('bill', () => {
    it('should deduct credits for consultation', () => {
      service.recharge('agent_1', 500);
      const result = service.bill('agent_1', 'expert_1', 100);

      // 100 + 500 - 100 = 500
      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(500);
    });

    it('should fail if insufficient balance', () => {
      service.recharge('agent_1', 50);
      // Balance = 100 + 50 = 150, try to bill 200
      const result = service.bill('agent_1', 'expert_1', 200);

      expect(result.success).toBe(false);
      expect(result.error).toBe('insufficient_balance');
    });

    it('should fail if daily limit exceeded', () => {
      service.recharge('agent_1', 500);
      service.setDailyLimit('agent_1', 100);
      const result = service.bill('agent_1', 'expert_1', 150);

      expect(result.success).toBe(false);
      expect(result.error).toBe('daily_limit_exceeded');
    });

    it('should track daily usage', () => {
      service.recharge('agent_1', 500);
      service.setDailyLimit('agent_1', 200);

      service.bill('agent_1', 'expert_1', 50);
      service.bill('agent_1', 'expert_2', 50);

      const account = service.getAccount('agent_1');
      expect(account?.usedToday).toBe(100);
    });

    it('should record consultation transaction', () => {
      service.recharge('agent_1', 500);
      service.bill('agent_1', 'expert_1', 100);

      const history = service.getTransactionHistory('agent_1');
      const consultation = history.find(t => t.type === 'consultation');

      expect(consultation).toBeDefined();
      expect(consultation?.amount).toBe(-100);
      expect(consultation?.expertId).toBe('expert_1');
    });

    it('should fail for non-existent account', () => {
      const result = service.bill('nonexistent', 'expert_1', 100);

      expect(result.success).toBe(false);
      expect(result.error).toBe('account_not_found');
    });
  });

  describe('canAfford', () => {
    it('should return true if can afford', () => {
      service.recharge('agent_1', 500);

      // Balance = 600, can afford 100
      expect(service.canAfford('agent_1', 100)).toBe(true);
    });

    it('should return false if insufficient balance', () => {
      service.recharge('agent_1', 50);
      // Balance = 150, cannot afford 200
      expect(service.canAfford('agent_1', 200)).toBe(false);
    });

    it('should return false if daily limit exceeded', () => {
      service.recharge('agent_1', 500);
      service.setDailyLimit('agent_1', 100);
      service.bill('agent_1', 'expert_1', 80);

      expect(service.canAfford('agent_1', 50)).toBe(false);
    });

    it('should return false for non-existent account', () => {
      expect(service.canAfford('nonexistent', 100)).toBe(false);
    });
  });

  describe('refund', () => {
    it('should refund a consultation', () => {
      service.recharge('agent_1', 500);
      const result = service.bill('agent_1', 'expert_1', 100);
      expect(result.success).toBe(true);

      const account = service.refund(result.transactionId!, 'test refund');

      // 600 - 100 + 100 = 600 (restored)
      expect(account?.balance).toBe(600);
    });

    it('should return undefined for non-existent transaction', () => {
      const account = service.refund('nonexistent_txn', 'test refund');

      expect(account).toBeUndefined();
    });

    it('should not refund non-consultation transactions', () => {
      service.recharge('agent_1', 500);
      const history = service.getTransactionHistory('agent_1');
      const rechargeTxn = history.find(t => t.type === 'recharge');

      const account = service.refund(rechargeTxn!.id, 'test refund');

      expect(account).toBeUndefined();
    });
  });

  describe('getTransactionHistory', () => {
    it('should return empty array for new account', () => {
      const history = service.getTransactionHistory('agent_1');

      expect(history).toEqual([]);
    });

    it('should return transactions in reverse order', async () => {
      service.recharge('agent_1', 500);
      await new Promise(resolve => setTimeout(resolve, 10));
      service.recharge('agent_1', 300);
      await new Promise(resolve => setTimeout(resolve, 10));
      service.recharge('agent_1', 200);

      const history = service.getTransactionHistory('agent_1', 10);

      expect(history).toHaveLength(3);
      expect(history[0].amount).toBe(200); // most recent first
      expect(history[2].amount).toBe(500);
    });

    it('should respect limit parameter', () => {
      service.recharge('agent_1', 500);
      service.recharge('agent_1', 300);
      service.recharge('agent_1', 200);

      const history = service.getTransactionHistory('agent_1', 2);

      expect(history).toHaveLength(2);
    });
  });

  describe('persistence', () => {
    it('should persist data to file', () => {
      service.recharge('agent_1', 500);

      // Create a new service instance to load from file
      const newService = new CreditService({ filePath: testFilePath });
      const account = newService.getAccount('agent_1');

      // Balance = 100 + 500 = 600
      expect(account?.balance).toBe(600);
    });

    it('should persist transactions', () => {
      service.recharge('agent_1', 500);
      service.bill('agent_1', 'expert_1', 100);

      const newService = new CreditService({ filePath: testFilePath });
      const history = newService.getTransactionHistory('agent_1');

      expect(history).toHaveLength(2);
    });
  });
});

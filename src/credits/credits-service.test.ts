/**
 * Tests for CreditsService.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CreditsService, getCreditsService } from './credits-service.js';

describe('CreditsService', () => {
  let service: CreditsService;
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    // Create a temp file for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-test-'));
    tempFile = path.join(tempDir, 'credits.json');
    service = new CreditsService({ filePath: tempFile });
  });

  afterEach(() => {
    // Clean up temp files
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe('getOrCreateAccount', () => {
    it('should create a new account with default values', () => {
      const account = service.getOrCreateAccount('agent-1', 'Test Agent');

      expect(account).toBeDefined();
      expect(account.agentId).toBe('agent-1');
      expect(account.name).toBe('Test Agent');
      expect(account.balance).toBe(0);
      expect(account.dailyLimit).toBe(0);
      expect(account.spentToday).toBe(0);
    });

    it('should return existing account', () => {
      service.getOrCreateAccount('agent-1', 'Test Agent');
      const account = service.getOrCreateAccount('agent-1', 'Different Name');

      expect(account.name).toBe('Different Name'); // Name should update
    });

    it('should persist account to file', () => {
      service.getOrCreateAccount('agent-1', 'Test Agent');

      expect(fs.existsSync(tempFile)).toBe(true);
      const data = JSON.parse(fs.readFileSync(tempFile, 'utf-8'));
      expect(data.accounts['agent-1']).toBeDefined();
    });
  });

  describe('canAfford', () => {
    it('should return false for non-existent account', () => {
      expect(service.canAfford('non-existent', 10)).toBe(false);
    });

    it('should return false if balance is insufficient', () => {
      service.getOrCreateAccount('agent-1');
      expect(service.canAfford('agent-1', 10)).toBe(false);
    });

    it('should return true if balance is sufficient', () => {
      const account = service.getOrCreateAccount('agent-1');
      account.balance = 100;
      service.recharge('agent-1', 100);

      expect(service.canAfford('agent-1', 50)).toBe(true);
    });

    it('should return false if daily limit exceeded', () => {
      service.getOrCreateAccount('agent-1');
      service.recharge('agent-1', 100);
      service.setDailyLimit('agent-1', 10);

      expect(service.canAfford('agent-1', 20)).toBe(false);
    });
  });

  describe('deductCredits', () => {
    it('should fail for non-existent account', () => {
      const result = service.deductCredits('non-existent', 10);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Account not found');
    });

    it('should fail if balance insufficient', () => {
      service.getOrCreateAccount('agent-1');
      const result = service.deductCredits('agent-1', 10);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient balance');
    });

    it('should fail if daily limit exceeded', () => {
      service.getOrCreateAccount('agent-1');
      service.recharge('agent-1', 100);
      service.setDailyLimit('agent-1', 5);

      const result = service.deductCredits('agent-1', 10);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Daily limit exceeded');
    });

    it('should deduct credits successfully', () => {
      service.getOrCreateAccount('agent-1');
      service.recharge('agent-1', 100);

      const result = service.deductCredits('agent-1', 30, 'Test deduction');

      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(70);
    });

    it('should update spentToday', () => {
      service.getOrCreateAccount('agent-1');
      service.recharge('agent-1', 100);
      service.setDailyLimit('agent-1', 50);

      service.deductCredits('agent-1', 20);
      const result = service.deductCredits('agent-1', 10);

      expect(result.success).toBe(true);
      expect(result.remainingDaily).toBe(20);
    });
  });

  describe('recharge', () => {
    it('should fail for non-existent account', () => {
      expect(service.recharge('non-existent', 100)).toBeUndefined();
    });

    it('should add credits to account', () => {
      service.getOrCreateAccount('agent-1');
      service.recharge('agent-1', 100);
      service.recharge('agent-1', 50);

      const account = service.getAccount('agent-1');
      expect(account?.balance).toBe(150);
    });
  });

  describe('setDailyLimit', () => {
    it('should fail for non-existent account', () => {
      expect(service.setDailyLimit('non-existent', 100)).toBeUndefined();
    });

    it('should set daily limit', () => {
      service.getOrCreateAccount('agent-1');
      const account = service.setDailyLimit('agent-1', 100);

      expect(account?.dailyLimit).toBe(100);
    });

    it('should not allow negative limit', () => {
      service.getOrCreateAccount('agent-1');
      const account = service.setDailyLimit('agent-1', -10);

      expect(account?.dailyLimit).toBe(0);
    });
  });

  describe('listAccounts', () => {
    it('should return empty array when no accounts', () => {
      expect(service.listAccounts()).toHaveLength(0);
    });

    it('should return all accounts', () => {
      service.getOrCreateAccount('agent-1', 'Agent 1');
      service.getOrCreateAccount('agent-2', 'Agent 2');

      const accounts = service.listAccounts();
      expect(accounts).toHaveLength(2);
      expect(accounts.map(a => a.agentId)).toContain('agent-1');
      expect(accounts.map(a => a.agentId)).toContain('agent-2');
    });
  });

  describe('daily reset', () => {
    it('should reset spentToday when date changes', () => {
      service.getOrCreateAccount('agent-1');
      service.recharge('agent-1', 100);

      // Manually set lastResetDate to yesterday
      const account = service.getAccount('agent-1')!;
      account.spentToday = 50;
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const [yesterdayDate] = yesterday.toISOString().split('T');
      account.lastResetDate = yesterdayDate;

      // Trigger reset by getting account again
      const resetAccount = service.getAccount('agent-1');

      const [todayDate] = new Date().toISOString().split('T');
      expect(resetAccount?.spentToday).toBe(0);
      expect(resetAccount?.lastResetDate).toBe(todayDate);
    });
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      const instance1 = getCreditsService();
      const instance2 = getCreditsService();

      expect(instance1).toBe(instance2);
    });
  });
});

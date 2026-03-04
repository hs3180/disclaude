/**
 * Tests for BudgetManager.
 *
 * Issue #538: 积分系统 - 身价与消费
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { BudgetManager, getBudgetManager, resetBudgetManager } from './budget-manager.js';

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/tmp/test-workspace-budget',
  },
}));

describe('BudgetManager', () => {
  let manager: BudgetManager;
  const testDir = '/tmp/test-workspace-budget';

  beforeEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
    await fs.mkdir(testDir, { recursive: true });

    // Reset singleton
    resetBudgetManager();
    manager = new BudgetManager(testDir);
  });

  afterEach(async () => {
    // Clean up
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('getOrCreateAccount', () => {
    it('should create a new account with default settings', async () => {
      const account = await manager.getOrCreateAccount('agent_001');

      expect(account.agentId).toBe('agent_001');
      expect(account.balance).toBe(0);
      expect(account.dailyLimit).toBe(100);
      expect(account.usedToday).toBe(0);
      expect(account.lastUsageDate).toBe(new Date().toISOString().split('T')[0]);
    });

    it('should return existing account', async () => {
      await manager.getOrCreateAccount('agent_001');
      const account = await manager.getOrCreateAccount('agent_001');

      expect(account.agentId).toBe('agent_001');
    });

    it('should reset daily usage on new day', async () => {
      // Create account
      await manager.getOrCreateAccount('agent_001');

      // Simulate usage
      await manager.recharge('agent_001', 100);
      await manager.consumeCredits('agent_001', 50, 'expert_001');

      // Get account again (simulates new instance on same day)
      const account2 = await manager.getAccount('agent_001');
      expect(account2?.usedToday).toBe(50);

      // Manually modify lastUsageDate to simulate new day
      const dataFile = path.join(testDir, 'budgets.json');
      const content = await fs.readFile(dataFile, 'utf-8');
      const registry = JSON.parse(content);
      registry.accounts[0].lastUsageDate = '2020-01-01';
      await fs.writeFile(dataFile, JSON.stringify(registry, null, 2));

      // Reset manager to reload data
      resetBudgetManager();
      manager = new BudgetManager(testDir);

      const account3 = await manager.getAccount('agent_001');
      expect(account3?.usedToday).toBe(0);
      expect(account3?.lastUsageDate).toBe(new Date().toISOString().split('T')[0]);
    });
  });

  describe('canSpend', () => {
    it('should return false for non-existent account', async () => {
      const result = await manager.canSpend('non_existent', 10);
      expect(result.canSpend).toBe(false);
      expect(result.reason).toContain('账户不存在');
    });

    it('should return false if balance is insufficient', async () => {
      await manager.recharge('agent_001', 50);
      const result = await manager.canSpend('agent_001', 100);
      expect(result.canSpend).toBe(false);
      expect(result.reason).toContain('余额不足');
    });

    it('should return false if daily limit is exceeded', async () => {
      await manager.recharge('agent_001', 200);
      await manager.setDailyLimit('agent_001', 50);
      await manager.consumeCredits('agent_001', 40, 'expert_001');

      const result = await manager.canSpend('agent_001', 20);
      expect(result.canSpend).toBe(false);
      expect(result.reason).toContain('已达每日上限');
    });

    it('should return true if sufficient balance and daily limit', async () => {
      await manager.recharge('agent_001', 100);
      const result = await manager.canSpend('agent_001', 50);
      expect(result.canSpend).toBe(true);
    });
  });

  describe('consumeCredits', () => {
    it('should fail for non-existent account', async () => {
      const result = await manager.consumeCredits('non_existent', 10, 'expert_001');
      expect(result.success).toBe(false);
      expect(result.error).toContain('账户不存在');
    });

    it('should fail if balance is insufficient', async () => {
      await manager.recharge('agent_001', 50);
      const result = await manager.consumeCredits('agent_001', 100, 'expert_001');
      expect(result.success).toBe(false);
      expect(result.error).toContain('余额不足');
    });

    it('should deduct credits and update usedToday', async () => {
      await manager.recharge('agent_001', 100);
      const result = await manager.consumeCredits('agent_001', 30, 'expert_001');

      expect(result.success).toBe(true);
      expect(result.account?.balance).toBe(70);
      expect(result.account?.usedToday).toBe(30);
    });

    it('should log consumption', async () => {
      await manager.recharge('agent_001', 100);
      await manager.consumeCredits('agent_001', 30, 'expert_001', 'Test consultation');

      const logs = await manager.getConsumptionLog('agent_001');
      expect(logs).toHaveLength(1);
      expect(logs[0].agentId).toBe('agent_001');
      expect(logs[0].expertId).toBe('expert_001');
      expect(logs[0].amount).toBe(30);
      expect(logs[0].description).toBe('Test consultation');
    });
  });

  describe('recharge', () => {
    it('should add credits to existing account', async () => {
      await manager.recharge('agent_001', 100);
      const account = await manager.recharge('agent_001', 50);

      expect(account.balance).toBe(150);
    });

    it('should create account if it does not exist', async () => {
      const account = await manager.recharge('agent_001', 100);

      expect(account.agentId).toBe('agent_001');
      expect(account.balance).toBe(100);
    });
  });

  describe('setDailyLimit', () => {
    it('should set daily limit for existing account', async () => {
      await manager.recharge('agent_001', 100);
      const account = await manager.setDailyLimit('agent_001', 200);

      expect(account?.dailyLimit).toBe(200);
    });

    it('should return undefined for non-existent account', async () => {
      const account = await manager.setDailyLimit('non_existent', 200);
      expect(account).toBeUndefined();
    });
  });

  describe('listAccounts', () => {
    it('should return empty array when no accounts', async () => {
      const accounts = await manager.listAccounts();
      expect(accounts).toHaveLength(0);
    });

    it('should return all accounts', async () => {
      await manager.recharge('agent_001', 100);
      await manager.recharge('agent_002', 200);

      const accounts = await manager.listAccounts();
      expect(accounts).toHaveLength(2);
    });
  });

  describe('getConsumptionLog', () => {
    it('should return empty array when no logs', async () => {
      const logs = await manager.getConsumptionLog();
      expect(logs).toHaveLength(0);
    });

    it('should filter by agentId', async () => {
      await manager.recharge('agent_001', 100);
      await manager.recharge('agent_002', 100);
      await manager.consumeCredits('agent_001', 10, 'expert_001');
      await manager.consumeCredits('agent_002', 20, 'expert_002');

      const logs1 = await manager.getConsumptionLog('agent_001');
      expect(logs1).toHaveLength(1);
      expect(logs1[0].agentId).toBe('agent_001');

      const logs2 = await manager.getConsumptionLog('agent_002');
      expect(logs2).toHaveLength(1);
      expect(logs2[0].agentId).toBe('agent_002');
    });
  });
});

describe('getBudgetManager singleton', () => {
  it('should return the same instance', () => {
    resetBudgetManager();
    const m1 = getBudgetManager();
    const m2 = getBudgetManager();
    expect(m1).toBe(m2);
  });

  it('should return new instance after reset', () => {
    resetBudgetManager();
    const m1 = getBudgetManager();
    resetBudgetManager();
    const m2 = getBudgetManager();
    expect(m1).not.toBe(m2);
  });
});

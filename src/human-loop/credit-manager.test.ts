/**
 * Tests for CreditManager (Issue #538: 积分系统 - 身价与消费)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import { CreditManager, getCreditManager } from './credit-manager.js';

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/tmp/test-workspace-credit',
  },
}));

describe('CreditManager', () => {
  let manager: CreditManager;
  const testWorkspace = '/tmp/test-workspace-credit';

  beforeEach(async () => {
    // Reset singleton
    vi.resetModules();

    // Create test workspace
    await fs.mkdir(testWorkspace, { recursive: true });

    // Create fresh instance
    manager = new CreditManager();
  });

  afterEach(async () => {
    // Cleanup test workspace
    try {
      await fs.rm(testWorkspace, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Account Management', () => {
    it('should create a new account on first access', async () => {
      const account = await manager.getOrCreateAccount('agent_001', 'Test Agent');

      expect(account).toBeDefined();
      expect(account.agentId).toBe('agent_001');
      expect(account.name).toBe('Test Agent');
      expect(account.balance).toBe(0);
      expect(account.dailyLimit).toBe(100);
      expect(account.usedToday).toBe(0);
    });

    it('should return existing account', async () => {
      await manager.getOrCreateAccount('agent_001', 'First Name');
      const account = await manager.getOrCreateAccount('agent_001', 'Updated Name');

      expect(account.name).toBe('Updated Name');
    });

    it('should recharge account', async () => {
      await manager.getOrCreateAccount('agent_001');
      const result = await manager.recharge('agent_001', 50);

      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(50);
    });

    it('should reject negative recharge', async () => {
      const result = await manager.recharge('agent_001', -10);

      expect(result.success).toBe(false);
      expect(result.error).toContain('必须大于 0');
    });

    it('should set daily limit', async () => {
      await manager.getOrCreateAccount('agent_001');
      const result = await manager.setDailyLimit('agent_001', 200);

      expect(result.success).toBe(true);

      const account = await manager.getAccount('agent_001');
      expect(account?.dailyLimit).toBe(200);
    });

    it('should reject negative daily limit', async () => {
      await manager.getOrCreateAccount('agent_001');
      const result = await manager.setDailyLimit('agent_001', -10);

      expect(result.success).toBe(false);
    });
  });

  describe('Expert Pricing', () => {
    it('should set expert price', async () => {
      const result = await manager.setExpertPrice('ou_expert_001', 10);

      expect(result.success).toBe(true);

      const price = await manager.getExpertPrice('ou_expert_001');
      expect(price).toBe(10);
    });

    it('should return 0 for unset expert price', async () => {
      const price = await manager.getExpertPrice('ou_unknown');

      expect(price).toBe(0);
    });

    it('should reject negative price', async () => {
      const result = await manager.setExpertPrice('ou_expert_001', -5);

      expect(result.success).toBe(false);
    });

    it('should update existing price', async () => {
      await manager.setExpertPrice('ou_expert_001', 10);
      await manager.setExpertPrice('ou_expert_001', 20);

      const price = await manager.getExpertPrice('ou_expert_001');
      expect(price).toBe(20);
    });
  });

  describe('Consultation Eligibility', () => {
    beforeEach(async () => {
      await manager.getOrCreateAccount('agent_001');
      await manager.recharge('agent_001', 100);
      await manager.setExpertPrice('ou_expert_001', 10);
    });

    it('should allow consultation with sufficient balance', async () => {
      const eligibility = await manager.checkConsultationEligibility('agent_001', 'ou_expert_001');

      expect(eligibility.allowed).toBe(true);
      expect(eligibility.balance).toBe(100);
      expect(eligibility.expertPrice).toBe(10);
    });

    it('should deny consultation with insufficient balance', async () => {
      await manager.setExpertPrice('ou_expert_001', 200);

      const eligibility = await manager.checkConsultationEligibility('agent_001', 'ou_expert_001');

      expect(eligibility.allowed).toBe(false);
      expect(eligibility.reason).toBe('insufficient_balance');
    });

    it('should deny consultation when daily limit exceeded', async () => {
      await manager.setDailyLimit('agent_001', 5);

      const eligibility = await manager.checkConsultationEligibility('agent_001', 'ou_expert_001');

      expect(eligibility.allowed).toBe(false);
      expect(eligibility.reason).toBe('daily_limit_exceeded');
    });

    it('should deny consultation for non-existent account', async () => {
      const eligibility = await manager.checkConsultationEligibility('unknown_agent', 'ou_expert_001');

      expect(eligibility.allowed).toBe(false);
      expect(eligibility.reason).toBe('account_not_found');
    });

    it('should allow free consultation (price = 0)', async () => {
      await manager.setExpertPrice('ou_free_expert', 0);

      const eligibility = await manager.checkConsultationEligibility('agent_001', 'ou_free_expert');

      expect(eligibility.allowed).toBe(true);
    });
  });

  describe('Consultation Charging', () => {
    beforeEach(async () => {
      await manager.getOrCreateAccount('agent_001');
      await manager.recharge('agent_001', 100);
      await manager.setExpertPrice('ou_expert_001', 10);
    });

    it('should charge for consultation', async () => {
      const result = await manager.chargeConsultation('agent_001', 'ou_expert_001');

      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(90);

      const account = await manager.getAccount('agent_001');
      expect(account?.usedToday).toBe(10);
    });

    it('should deny charge with insufficient balance', async () => {
      await manager.setExpertPrice('ou_expert_001', 200);

      const result = await manager.chargeConsultation('agent_001', 'ou_expert_001');

      expect(result.success).toBe(false);
      expect(result.error).toContain('积分不足');
    });

    it('should deny charge when daily limit exceeded', async () => {
      await manager.setDailyLimit('agent_001', 5);

      const result = await manager.chargeConsultation('agent_001', 'ou_expert_001');

      expect(result.success).toBe(false);
      expect(result.error).toContain('每日上限');
    });

    it('should record transaction', async () => {
      await manager.chargeConsultation('agent_001', 'ou_expert_001', 'Test consultation');

      const history = await manager.getTransactionHistory('agent_001');

      // History includes the recharge from beforeEach, so we check the latest (consultation)
      expect(history.length).toBe(2); // recharge + consultation
      expect(history[0].type).toBe('consultation');
      expect(history[0].amount).toBe(-10);
    });
  });

  describe('Refund', () => {
    beforeEach(async () => {
      await manager.getOrCreateAccount('agent_001');
      await manager.recharge('agent_001', 100);
    });

    it('should refund credits', async () => {
      const result = await manager.refund('agent_001', 'ou_expert_001', 10, 'Test refund');

      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(110);
    });

    it('should record refund transaction', async () => {
      await manager.refund('agent_001', 'ou_expert_001', 10, 'Test refund');

      const history = await manager.getTransactionHistory('agent_001');

      expect(history.length).toBe(2); // recharge + refund
      expect(history[0].type).toBe('refund');
    });
  });

  describe('Daily Reset', () => {
    it('should reset daily usage on new day', async () => {
      // Create account and use some credits
      await manager.getOrCreateAccount('agent_001');
      await manager.recharge('agent_001', 100);
      await manager.setExpertPrice('ou_expert_001', 10);
      await manager.chargeConsultation('agent_001', 'ou_expert_001');

      // Manually set lastResetDate to yesterday
      const account = await manager.getAccount('agent_001');
      if (account) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        account.lastResetDate = yesterday.toISOString().split('T')[0];
        // Force save
        await (manager as any).save();
      }

      // Access account again - should reset
      const resetAccount = await manager.getAccount('agent_001');

      expect(resetAccount?.usedToday).toBe(0);
      expect(resetAccount?.lastResetDate).toBe(new Date().toISOString().split('T')[0]);
    });
  });

  describe('Transaction History', () => {
    beforeEach(async () => {
      await manager.getOrCreateAccount('agent_001');
    });

    it('should record recharge transactions', async () => {
      await manager.recharge('agent_001', 50);
      await manager.recharge('agent_001', 30);

      const history = await manager.getTransactionHistory('agent_001');

      expect(history.length).toBe(2);
    });

    it('should limit history to requested count', async () => {
      for (let i = 0; i < 10; i++) {
        await manager.recharge('agent_001', 10);
      }

      const history = await manager.getTransactionHistory('agent_001', 5);

      expect(history.length).toBe(5);
    });
  });

  describe('Singleton', () => {
    it('should return same instance', () => {
      const instance1 = getCreditManager();
      const instance2 = getCreditManager();

      expect(instance1).toBe(instance2);
    });
  });
});

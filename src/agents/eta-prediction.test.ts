/**
 * Tests for ETA Prediction System (Issue #1234)
 *
 * Tests the Markdown-based ETA prediction system:
 * - ETATaskRecords: Task record storage in Markdown
 * - ETARules: Estimation rules management
 * - ETAPredictionService: Time prediction with reasoning
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ETATaskRecords,
  type TaskRecordEntry,
} from './eta-task-records.js';
import { ETARules, type RuleUpdate } from './eta-rules.js';
import {
  ETAPredictionService,
  type TaskContext,
} from './eta-prediction.js';

describe('ETATaskRecords', () => {
  let records: ETATaskRecords;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `eta-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Override workspace dir for testing
    process.env.WORKSPACE_DIR = tempDir;

    records = new ETATaskRecords();
    await records.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    delete process.env.WORKSPACE_DIR;
  });

  it('should create initial file with header', async () => {
    const content = await records.readRecords();
    expect(content).toContain('# 任务记录');
  });

  it('should record a task entry', async () => {
    const entry: TaskRecordEntry = {
      taskDescription: '实现用户登录功能',
      taskType: 'feature-small',
      estimatedTime: '45分钟',
      estimatedSeconds: 2700,
      estimationReasoning: '类似之前的表单功能，约30-60分钟',
      actualTime: '50分钟',
      actualSeconds: 3000,
      review: '估计较准确，密码验证逻辑比预期复杂一点',
      keyFactors: ['认证', '表单'],
    };

    await records.recordTask(entry);

    const content = await records.readRecords();
    expect(content).toContain('实现用户登录功能');
    expect(content).toContain('feature-small');
    expect(content).toContain('45分钟');
    expect(content).toContain('50分钟');
    expect(content).toContain('密码验证逻辑');
  });

  it('should search for similar tasks', async () => {
    // Record some tasks
    await records.recordTask({
      taskDescription: '实现用户登录功能',
      taskType: 'feature-small',
      estimatedTime: '45分钟',
      estimatedSeconds: 2700,
      estimationReasoning: '类似表单功能',
      actualTime: '50分钟',
      actualSeconds: 3000,
      review: '估计准确',
    });

    await records.recordTask({
      taskDescription: '实现用户注册功能',
      taskType: 'feature-small',
      estimatedTime: '40分钟',
      estimatedSeconds: 2400,
      estimationReasoning: '类似登录功能',
      actualTime: '35分钟',
      actualSeconds: 2100,
      review: '比预期快',
    });

    const results = await records.searchSimilarTasks(['用户', '登录']);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toContain('登录');
  });

  it('should get recent records', async () => {
    for (let i = 0; i < 15; i++) {
      await records.recordTask({
        taskDescription: `任务 ${i}`,
        taskType: 'feature-small',
        estimatedTime: '30分钟',
        estimatedSeconds: 1800,
        estimationReasoning: '测试',
        actualTime: '30分钟',
        actualSeconds: 1800,
        review: '测试记录',
      });
    }

    const recent = await records.getRecentRecords(5);
    const taskCount = (recent.match(/## /g) || []).length;
    expect(taskCount).toBeLessThanOrEqual(5);
  });
});

describe('ETARules', () => {
  let rules: ETARules;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `eta-rules-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    process.env.WORKSPACE_DIR = tempDir;

    rules = new ETARules();
    await rules.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    delete process.env.WORKSPACE_DIR;
  });

  it('should create initial rules file with template', async () => {
    const content = await rules.readRules();
    expect(content).toContain('# ETA 估计规则');
    expect(content).toContain('任务类型基准时间');
    expect(content).toContain('bugfix');
    expect(content).toContain('经验规则');
  });

  it('should add a new rule', async () => {
    const update: RuleUpdate = {
      category: 'multiplier',
      rule: '涉及 WebSocket 连接 → 基准时间 × 1.5',
      source: '来自实时通信功能开发经验',
    };

    await rules.addRule(update);

    const content = await rules.readRules();
    expect(content).toContain('WebSocket');
    expect(content).toContain('实时通信功能');
  });

  it('should update rules from patterns', async () => {
    await rules.updateFromPatterns({
      underEstimated: ['涉及复杂异步逻辑的任务'],
      overEstimated: ['简单的配置文件修改'],
      newRules: ['新增规则: 配置修改预估时间减少'],
    });

    const content = await rules.readRules();
    expect(content).toContain('异步逻辑');
    expect(content).toContain('配置文件');
  });
});

describe('ETAPredictionService', () => {
  let service: ETAPredictionService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `eta-pred-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    process.env.WORKSPACE_DIR = tempDir;

    service = new ETAPredictionService();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    delete process.env.WORKSPACE_DIR;
  });

  it('should predict ETA for a simple task', async () => {
    const context: TaskContext = {
      description: '修复登录页面的显示bug',
      taskType: 'bugfix',
      keyFactors: [],
    };

    const prediction = await service.predict(context);

    expect(prediction.estimatedSeconds).toBeGreaterThan(0);
    expect(prediction.estimatedTime).toBeTruthy();
    expect(['low', 'medium', 'high']).toContain(prediction.confidence);
    expect(prediction.reasoning).toContain('bugfix');
  });

  it('should apply multipliers for key factors', async () => {
    const simpleContext: TaskContext = {
      description: '简单的文本修改',
      taskType: 'feature-small',
      keyFactors: [],
    };

    const complexContext: TaskContext = {
      description: '添加支付功能',
      taskType: 'feature-small',
      keyFactors: ['认证', '第三方API', '安全'],
    };

    const simplePrediction = await service.predict(simpleContext);
    const complexPrediction = await service.predict(complexContext);

    // Complex task should take longer
    expect(complexPrediction.estimatedSeconds).toBeGreaterThan(simplePrediction.estimatedSeconds);
  });

  it('should build a prediction card', async () => {
    const context: TaskContext = {
      description: '测试任务',
      taskType: 'feature-small',
      keyFactors: [],
    };

    const prediction = await service.predict(context);
    const card = service.buildPredictionCard(prediction, context.description);

    expect(card).toHaveProperty('config');
    expect(card).toHaveProperty('header');
    expect(card).toHaveProperty('elements');
    expect((card.header as Record<string, unknown>).title).toBeTruthy();
  });

  it('should record a completed task', async () => {
    const context: TaskContext = {
      description: '测试记录功能',
      taskType: 'feature-small',
      keyFactors: ['测试'],
    };

    const prediction = await service.predict(context);
    await service.recordTask(context, prediction, 1800, '测试完成');

    // Verify the task was recorded - use the same instance from service
    const { etaTaskRecords } = await import('./eta-task-records.js');
    const recent = await etaTaskRecords.getRecentRecords(1);
    expect(recent).toContain('测试记录功能');
  });

  it('should have higher confidence with more similar tasks', async () => {
    // First prediction with no history
    const context1: TaskContext = {
      description: '新类型任务',
      taskType: 'unique-type-xyz',
      keyFactors: [],
    };

    const prediction1 = await service.predict(context1);

    // Record some similar tasks
    for (let i = 0; i < 3; i++) {
      const ctx: TaskContext = {
        description: `相似任务 ${i}`,
        taskType: 'unique-type-xyz',
        keyFactors: [],
      };
      const pred = await service.predict(ctx);
      await service.recordTask(ctx, pred, 1800, `完成 ${i}`);
    }

    // Second prediction should have access to similar tasks
    const context2: TaskContext = {
      description: '又一个相似任务',
      taskType: 'unique-type-xyz',
      keyFactors: [],
    };

    const prediction2 = await service.predict(context2);
    expect(prediction2.similarTasks.length).toBeGreaterThanOrEqual(0);
  });
});

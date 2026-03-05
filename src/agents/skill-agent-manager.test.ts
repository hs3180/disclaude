/**
 * Tests for SkillAgentManager.
 *
 * Issue #455: Skill Agent 系统 - 后台执行的独立 Agent 进程
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  SkillAgentManager,
  resetSkillAgentManager,
} from './skill-agent-manager.js';
import type { BaseAgentConfig } from './types.js';

// Test skill content
const TEST_SKILL_CONTENT = `---
name: test-skill
description: A test skill for unit testing
---

# Test Skill

This is a test skill.
`;

describe('SkillAgentManager', () => {
  let tempDir: string;
  let skillsDir: string;
  let manager: SkillAgentManager;
  let mockConfig: BaseAgentConfig;

  beforeEach(async () => {
    // Create temp directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-manager-test-'));
    skillsDir = path.join(tempDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

    // Mock config
    mockConfig = {
      apiKey: 'test-api-key',
      model: 'claude-3-5-sonnet-20241022',
      provider: 'anthropic',
    };

    // Reset global manager
    resetSkillAgentManager();

    // Create manager
    manager = new SkillAgentManager(mockConfig);

    // Override discoverSkills to use tempDir and update internal cache
    (manager as any).discoverSkills = async function(forceRefresh = false) {
      // Use tempDir instead of Config.getWorkspaceDir()
      const skillsDirPath = path.join(tempDir, 'skills');
      const skills: { name: string; skillPath: string; description?: string }[] = [];
      const now = Date.now();

      // Check cache
      if (!forceRefresh && (this as any).skillCache.size > 0 && (now - (this as any).cacheTimestamp) < (this as any).CACHE_TTL) {
        return Array.from((this as any).skillCache.values());
      }

      try {
        const entries = await fs.readdir(skillsDirPath, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isDirectory()) {
            continue;
          }

          const skillPath = path.join(skillsDirPath, entry.name, 'SKILL.md');

          try {
            await fs.access(skillPath);

            const skillInfo = {
              name: entry.name,
              skillPath,
            };

            try {
              const content = await fs.readFile(skillPath, 'utf-8');
              const descMatch = content.match(/^description:\s*(.+)$/m);
              if (descMatch) {
                (skillInfo as any).description = descMatch[1].trim();
              }
            } catch {
              // Ignore parsing errors
            }

            skills.push(skillInfo);
            (this as any).skillCache.set(skillInfo.name, skillInfo);
          } catch {
            // SKILL.md doesn't exist, skip
          }
        }

        (this as any).cacheTimestamp = now;
      } catch {
        // Directory not found or other error
      }

      return skills;
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    resetSkillAgentManager();
  });

  describe('discoverSkills', () => {
    it('should return empty array when skills directory is empty', async () => {
      const skills = await manager.discoverSkills();

      expect(skills).toEqual([]);
    });

    it('should discover skills from directory', async () => {
      // Create test skill
      const skillDir = path.join(skillsDir, 'test-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), TEST_SKILL_CONTENT);

      const skills = await manager.discoverSkills();

      expect(skills.length).toBe(1);
      expect(skills[0].name).toBe('test-skill');
      expect(skills[0].description).toBe('A test skill for unit testing');
    });

    it('should ignore directories without SKILL.md', async () => {
      // Create directory without SKILL.md
      const emptyDir = path.join(skillsDir, 'empty-skill');
      await fs.mkdir(emptyDir, { recursive: true });

      // Create skill with SKILL.md
      const skillDir = path.join(skillsDir, 'valid-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), TEST_SKILL_CONTENT);

      const skills = await manager.discoverSkills();

      expect(skills.length).toBe(1);
      expect(skills[0].name).toBe('valid-skill');
    });
  });

  describe('getSkill', () => {
    it('should return undefined for non-existent skill', async () => {
      const skill = await manager.getSkill('non-existent');

      expect(skill).toBeUndefined();
    });

    it('should return skill info for existing skill', async () => {
      const skillDir = path.join(skillsDir, 'existing-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), TEST_SKILL_CONTENT);

      const skill = await manager.getSkill('existing-skill');

      expect(skill).toBeDefined();
      expect(skill?.name).toBe('existing-skill');
    });
  });

  describe('start', () => {
    it('should throw error for non-existent skill', async () => {
      await expect(
        manager.start('non-existent', { chatId: 'test-chat' })
      ).rejects.toThrow('Skill not found: non-existent');
    });

    it('should start skill agent and return agent ID', async () => {
      const skillDir = path.join(skillsDir, 'startable-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), TEST_SKILL_CONTENT);

      const agentId = await manager.start('startable-skill', { chatId: 'test-chat' });

      expect(agentId).toMatch(/^startable-skill-[a-f0-9]{8}$/);
    });

    it('should track running agent', async () => {
      const skillDir = path.join(skillsDir, 'trackable-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), TEST_SKILL_CONTENT);

      const agentId = await manager.start('trackable-skill', { chatId: 'test-chat' });

      const runningAgents = manager.list();
      expect(runningAgents.length).toBe(1);
      expect(runningAgents[0].id).toBe(agentId);
    });
  });

  describe('stop', () => {
    it('should return false for non-existent agent', () => {
      const stopped = manager.stop('non-existent');

      expect(stopped).toBe(false);
    });

    it('should stop running agent', async () => {
      const skillDir = path.join(skillsDir, 'stoppable-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), TEST_SKILL_CONTENT);

      const agentId = await manager.start('stoppable-skill', { chatId: 'test-chat' });
      const stopped = manager.stop(agentId);

      expect(stopped).toBe(true);

      const status = manager.getStatus(agentId);
      expect(status?.status).toBe('stopped');
    });
  });

  describe('getStatus', () => {
    it('should return undefined for non-existent agent', () => {
      const status = manager.getStatus('non-existent');

      expect(status).toBeUndefined();
    });

    it('should return status for running agent', async () => {
      const skillDir = path.join(skillsDir, 'status-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), TEST_SKILL_CONTENT);

      const agentId = await manager.start('status-skill', { chatId: 'test-chat' });
      const status = manager.getStatus(agentId);

      expect(status).toBeDefined();
      expect(status?.skillName).toBe('status-skill');
      expect(status?.chatId).toBe('test-chat');
    });
  });

  describe('list', () => {
    it('should return empty array when no agents running', () => {
      const agents = manager.list();

      expect(agents).toEqual([]);
    });

    it('should return running agents', async () => {
      const skillDir = path.join(skillsDir, 'list-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), TEST_SKILL_CONTENT);

      const agentId = await manager.start('list-skill', { chatId: 'test-chat' });

      const agents = manager.list();
      expect(agents.length).toBe(1);
      expect(agents[0].id).toBe(agentId);
    });
  });

  describe('cleanup', () => {
    it('should not throw when no agents to clean up', () => {
      expect(() => manager.cleanup()).not.toThrow();
    });

    it('should remove old completed agents', async () => {
      const skillDir = path.join(skillsDir, 'cleanup-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), TEST_SKILL_CONTENT);

      const agentId = await manager.start('cleanup-skill', { chatId: 'test-chat' });
      manager.stop(agentId);

      // Wait a bit to ensure time difference
      await new Promise(resolve => setTimeout(resolve, 10));

      // Run cleanup with 1ms max age
      manager.cleanup(1);

      const status = manager.getStatus(agentId);
      expect(status).toBeUndefined();
    });
  });
});

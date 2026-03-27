/**
 * Tests for Research State File Management.
 *
 * Issue #1710: RESEARCH.md 研究状态文件
 *
 * Uses real filesystem via temp directories (no mocks for fs operations).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  ResearchStateFile,
  generateResearchTemplate,
  RESEARCH_STATE_FILENAME,
} from './research-state.js';

describe('generateResearchTemplate', () => {
  it('should include topic as header', () => {
    const template = generateResearchTemplate('AI Safety');
    expect(template).toContain('# AI Safety');
  });

  it('should include all required sections', () => {
    const template = generateResearchTemplate('Test Topic');
    expect(template).toContain('## Research Goals');
    expect(template).toContain('## Findings');
    expect(template).toContain('## Pending Questions');
    expect(template).toContain('## Conclusions');
    expect(template).toContain('## Resources');
  });

  it('should include research start date', () => {
    const template = generateResearchTemplate('Test');
    const today = new Date().toISOString().slice(0, 10);
    expect(template).toContain(today);
  });

  it('should include auto-maintained marker', () => {
    const template = generateResearchTemplate('Test');
    expect(template).toContain('Auto-maintained by Research Mode agent');
  });

  it('should include checkbox items in Goals and Questions', () => {
    const template = generateResearchTemplate('Test');
    expect(template).toContain('- [ ] Define primary research objectives');
    expect(template).toContain('- [ ] Question 1 (to be filled)');
  });

  it('should handle CJK topics', () => {
    const template = generateResearchTemplate('大模型安全研究');
    expect(template).toContain('# 大模型安全研究');
  });

  it('should handle empty topic gracefully', () => {
    const template = generateResearchTemplate('');
    expect(template).toContain('# ');
  });
});

describe('ResearchStateFile', () => {
  let tempDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-state-test-'));
    workspaceDir = path.join(tempDir, 'research', 'test-topic');
    await fs.mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should set correct file path', () => {
      const stateFile = new ResearchStateFile(workspaceDir);
      expect(stateFile.getFilePath()).toBe(
        path.join(workspaceDir, RESEARCH_STATE_FILENAME)
      );
    });

    it('should set correct workspace directory', () => {
      const stateFile = new ResearchStateFile(workspaceDir);
      expect(stateFile.getWorkspaceDir()).toBe(workspaceDir);
    });
  });

  describe('exists', () => {
    it('should return false when file does not exist', async () => {
      const stateFile = new ResearchStateFile(workspaceDir);
      expect(await stateFile.exists()).toBe(false);
    });

    it('should return true when file exists', async () => {
      const stateFile = new ResearchStateFile(workspaceDir);
      await fs.writeFile(stateFile.getFilePath(), '# Test', 'utf-8');
      expect(await stateFile.exists()).toBe(true);
    });
  });

  describe('read', () => {
    it('should throw when file does not exist', async () => {
      const stateFile = new ResearchStateFile(workspaceDir);
      await expect(stateFile.read()).rejects.toThrow();
    });

    it('should return file content when file exists', async () => {
      const stateFile = new ResearchStateFile(workspaceDir);
      const content = '# My Research\n\nSome content';
      await fs.writeFile(stateFile.getFilePath(), content, 'utf-8');
      expect(await stateFile.read()).toBe(content);
    });
  });

  describe('init', () => {
    it('should create RESEARCH.md with template', async () => {
      const stateFile = new ResearchStateFile(workspaceDir);
      const filePath = await stateFile.init('AI Alignment');

      expect(filePath).toBe(stateFile.getFilePath());
      expect(await stateFile.exists()).toBe(true);

      const content = await stateFile.read();
      expect(content).toContain('# AI Alignment');
      expect(content).toContain('## Research Goals');
      expect(content).toContain('## Findings');
    });

    it('should not overwrite existing RESEARCH.md', async () => {
      const stateFile = new ResearchStateFile(workspaceDir);
      const customContent = '# Custom Research State\n\nPreserved content';

      // Pre-create file with custom content
      await fs.writeFile(stateFile.getFilePath(), customContent, 'utf-8');

      // Init should skip
      await stateFile.init('New Topic');

      const content = await stateFile.read();
      expect(content).toBe(customContent);
      expect(content).not.toContain('New Topic');
    });

    it('should include start date in generated template', async () => {
      const stateFile = new ResearchStateFile(workspaceDir);
      await stateFile.init('Test');

      const content = await stateFile.read();
      const today = new Date().toISOString().slice(0, 10);
      expect(content).toContain(today);
    });

    it('should return the file path', async () => {
      const stateFile = new ResearchStateFile(workspaceDir);
      const result = await stateFile.init('Test');

      expect(result).toContain(RESEARCH_STATE_FILENAME);
      expect(result).toContain(workspaceDir);
    });

    it('should work with CJK topic names', async () => {
      const stateFile = new ResearchStateFile(workspaceDir);
      await stateFile.init('深度学习研究');

      const content = await stateFile.read();
      expect(content).toContain('# 深度学习研究');
    });
  });

  describe('getFilePath', () => {
    it('should return absolute path ending with RESEARCH.md', () => {
      const stateFile = new ResearchStateFile(workspaceDir);
      const filePath = stateFile.getFilePath();
      expect(filePath).toMatch(/RESEARCH\.md$/);
      expect(path.isAbsolute(filePath)).toBe(true);
    });
  });

  describe('getWorkspaceDir', () => {
    it('should return the workspace directory', () => {
      const stateFile = new ResearchStateFile(workspaceDir);
      expect(stateFile.getWorkspaceDir()).toBe(workspaceDir);
    });
  });
});

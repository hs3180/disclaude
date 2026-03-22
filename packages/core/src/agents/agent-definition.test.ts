/**
 * Tests for Agent Definition module.
 *
 * Issue #1410: Project-level Agent definition system.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  parseFrontmatter,
  loadAgentDefinition,
  findAgentDefinition,
  listAgentDefinitions,
  type AgentSearchPath,
} from './agent-definition.js';

describe('Agent Definition', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-def-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('parseFrontmatter', () => {
    it('should parse basic frontmatter', () => {
      const content = `---
name: test-agent
description: Test description
---
Instructions here`;

      const [frontmatter, body] = parseFrontmatter(content);

      expect(frontmatter.name).toBe('test-agent');
      expect(frontmatter.description).toBe('Test description');
      expect(body).toBe('Instructions here');
    });

    it('should parse array tools with bracket syntax', () => {
      const content = `---
tools: ["Read", "Write", "Edit"]
---
Body`;

      const [frontmatter] = parseFrontmatter(content);

      expect(frontmatter.tools).toEqual(['Read', 'Write', 'Edit']);
    });

    it('should parse array with list syntax', () => {
      const content = `---
tools:
  - Read
  - Write
  - Edit
---
Body`;

      const [frontmatter] = parseFrontmatter(content);

      expect(frontmatter.tools).toEqual(['Read', 'Write', 'Edit']);
    });

    it('should parse boolean values', () => {
      const content = `---
background: true
---
Body`;

      const [frontmatter] = parseFrontmatter(content);

      expect(frontmatter.background).toBe(true);
    });

    it('should handle content without frontmatter', () => {
      const content = 'Just instructions without frontmatter';

      const [frontmatter, body] = parseFrontmatter(content);

      expect(frontmatter).toEqual({});
      expect(body).toBe(content);
    });

    it('should handle quoted strings', () => {
      const content = `---
description: "A description with: colon and spaces"
---
Body`;

      const [frontmatter] = parseFrontmatter(content);

      expect(frontmatter.description).toBe('A description with: colon and spaces');
    });

    it('should parse model and category', () => {
      const content = `---
model: sonnet
category: schedule
---
Body`;

      const [frontmatter] = parseFrontmatter(content);

      expect(frontmatter.model).toBe('sonnet');
      expect(frontmatter.category).toBe('schedule');
    });
  });

  describe('loadAgentDefinition', () => {
    it('should load agent definition from file', async () => {
      const agentFile = path.join(tempDir, 'test-agent.md');
      const content = `---
name: test-agent
description: Test agent description
tools: ["Read", "Write"]
model: sonnet
category: task
---
You are a test agent.
Execute tasks efficiently.`;

      await fs.writeFile(agentFile, content);

      const def = await loadAgentDefinition(agentFile);

      expect(def.name).toBe('test-agent');
      expect(def.description).toBe('Test agent description');
      expect(def.tools).toEqual(['Read', 'Write']);
      expect(def.model).toBe('sonnet');
      expect(def.category).toBe('task');
      expect(def.instructions).toBe('You are a test agent.\nExecute tasks efficiently.');
      expect(def.filePath).toBe(agentFile);
    });

    it('should use filename as name when not in frontmatter', async () => {
      const agentFile = path.join(tempDir, 'my-custom-agent.md');
      const content = `---
description: Custom agent
---
Instructions`;

      await fs.writeFile(agentFile, content);

      const def = await loadAgentDefinition(agentFile);

      expect(def.name).toBe('my-custom-agent');
    });

    it('should handle minimal frontmatter', async () => {
      const agentFile = path.join(tempDir, 'minimal.md');
      const content = `---
---
Just instructions`;

      await fs.writeFile(agentFile, content);

      const def = await loadAgentDefinition(agentFile);

      expect(def.name).toBe('minimal');
      expect(def.description).toBe('');
      expect(def.instructions).toBe('Just instructions');
    });

    it('should throw for non-existent file', async () => {
      await expect(loadAgentDefinition('/non/existent/file.md')).rejects.toThrow();
    });
  });

  describe('findAgentDefinition', () => {
    it('should find agent in search paths', async () => {
      const agentsDir = path.join(tempDir, 'agents');
      await fs.mkdir(agentsDir, { recursive: true });

      const agentFile = path.join(agentsDir, 'found-agent.md');
      await fs.writeFile(agentFile, `---
name: found-agent
description: Found agent
---
Instructions`);

      const searchPaths: AgentSearchPath[] = [
        { path: agentsDir, domain: 'project', priority: 10 },
      ];

      const def = await findAgentDefinition('found-agent', searchPaths);

      expect(def).not.toBeNull();
      expect(def?.name).toBe('found-agent');
    });

    it('should return null for non-existent agent', async () => {
      const searchPaths: AgentSearchPath[] = [
        { path: path.join(tempDir, 'agents'), domain: 'project', priority: 10 },
      ];

      const def = await findAgentDefinition('non-existent', searchPaths);

      expect(def).toBeNull();
    });

    it('should prefer higher priority path', async () => {
      const highPriorityDir = path.join(tempDir, 'high');
      const lowPriorityDir = path.join(tempDir, 'low');

      await fs.mkdir(highPriorityDir, { recursive: true });
      await fs.mkdir(lowPriorityDir, { recursive: true });

      await fs.writeFile(
        path.join(highPriorityDir, 'priority-agent.md'),
        `---
description: High priority
---
High`
      );

      await fs.writeFile(
        path.join(lowPriorityDir, 'priority-agent.md'),
        `---
description: Low priority
---
Low`
      );

      const searchPaths: AgentSearchPath[] = [
        { path: lowPriorityDir, domain: 'workspace', priority: 10 },
        { path: highPriorityDir, domain: 'project', priority: 30 },
      ];

      const def = await findAgentDefinition('priority-agent', searchPaths);

      expect(def?.description).toBe('High priority');
    });
  });

  describe('listAgentDefinitions', () => {
    it('should list all agents', async () => {
      const agentsDir = path.join(tempDir, 'agents');
      await fs.mkdir(agentsDir, { recursive: true });

      await fs.writeFile(
        path.join(agentsDir, 'agent-one.md'),
        `---
description: Agent one
---
One`
      );

      await fs.writeFile(
        path.join(agentsDir, 'agent-two.md'),
        `---
description: Agent two
---
Two`
      );

      // Create a non-markdown file (should be ignored)
      await fs.writeFile(path.join(agentsDir, 'not-an-agent.txt'), 'Text');

      const searchPaths: AgentSearchPath[] = [
        { path: agentsDir, domain: 'project', priority: 10 },
      ];

      const agents = await listAgentDefinitions(searchPaths);

      expect(agents).toHaveLength(2);
      const names = agents.map((a) => a.definition.name).sort();
      expect(names).toEqual(['agent-one', 'agent-two']);
    });

    it('should return empty array for non-existent directory', async () => {
      const searchPaths: AgentSearchPath[] = [
        { path: path.join(tempDir, 'non-existent'), domain: 'project', priority: 10 },
      ];

      const agents = await listAgentDefinitions(searchPaths);

      expect(agents).toEqual([]);
    });

    it('should deduplicate by priority', async () => {
      const highDir = path.join(tempDir, 'high');
      const lowDir = path.join(tempDir, 'low');

      await fs.mkdir(highDir, { recursive: true });
      await fs.mkdir(lowDir, { recursive: true });

      await fs.writeFile(
        path.join(highDir, 'dup-agent.md'),
        `---
description: High version
---
High`
      );

      await fs.writeFile(
        path.join(lowDir, 'dup-agent.md'),
        `---
description: Low version
---
Low`
      );

      const searchPaths: AgentSearchPath[] = [
        { path: lowDir, domain: 'workspace', priority: 10 },
        { path: highDir, domain: 'project', priority: 30 },
      ];

      const agents = await listAgentDefinitions(searchPaths);

      expect(agents).toHaveLength(1);
      expect(agents[0].definition.description).toBe('High version');
      expect(agents[0].domain).toBe('project');
      expect(agents[0].priority).toBe(30);
    });
  });
});

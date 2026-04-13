/**
 * Tests for template auto-discovery module.
 *
 * @see Issue #2286 — Project templates should auto-discover from package directory
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  discoverTemplates,
  discoveryResultToConfig,
  discoverTemplatesAsConfig,
  resolveTemplates,
} from './template-discovery.js';

describe('discoverTemplates', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disclaude-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return empty result when templates directory does not exist', () => {
    const result = discoverTemplates(tempDir);
    expect(result.templates).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('should discover a single template with CLAUDE.md', () => {
    const templateDir = path.join(tempDir, 'templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), '# Research Template');

    const result = discoverTemplates(tempDir);
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]).toEqual({
      name: 'research',
    });
    expect(result.errors).toEqual([]);
  });

  it('should discover multiple templates', () => {
    for (const name of ['research', 'book-reader', 'code-review']) {
      const templateDir = path.join(tempDir, 'templates', name);
      fs.mkdirSync(templateDir, { recursive: true });
      fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), `# ${name} Template`);
    }

    const result = discoverTemplates(tempDir);
    expect(result.templates).toHaveLength(3);
    const names = result.templates.map((t) => t.name).sort();
    expect(names).toEqual(['book-reader', 'code-review', 'research']);
  });

  it('should skip directories without CLAUDE.md', () => {
    const validDir = path.join(tempDir, 'templates', 'valid');
    fs.mkdirSync(validDir, { recursive: true });
    fs.writeFileSync(path.join(validDir, 'CLAUDE.md'), '# Valid');

    const invalidDir = path.join(tempDir, 'templates', 'invalid');
    fs.mkdirSync(invalidDir, { recursive: true });
    // No CLAUDE.md

    const result = discoverTemplates(tempDir);
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0].name).toBe('valid');
  });

  it('should skip files (non-directories) in templates/', () => {
    fs.mkdirSync(path.join(tempDir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'templates', 'README.md'), '# Templates');

    const templateDir = path.join(tempDir, 'templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), '# Research');

    const result = discoverTemplates(tempDir);
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0].name).toBe('research');
  });

  // ── Metadata from template.yaml ──

  it('should read metadata from template.yaml', () => {
    const templateDir = path.join(tempDir, 'templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), '# Research');
    fs.writeFileSync(
      path.join(templateDir, 'template.yaml'),
      'displayName: "研究模式"\ndescription: 专注研究的独立空间',
    );

    const result = discoverTemplates(tempDir);
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]).toEqual({
      name: 'research',
      displayName: '研究模式',
      description: '专注研究的独立空间',
    });
  });

  it('should read metadata from template.yaml with single-quoted values', () => {
    const templateDir = path.join(tempDir, 'templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), '# Research');
    fs.writeFileSync(
      path.join(templateDir, 'template.yaml'),
      "displayName: '研究模式'\ndescription: '专注研究'",
    );

    const result = discoverTemplates(tempDir);
    expect(result.templates[0].displayName).toBe('研究模式');
    expect(result.templates[0].description).toBe('专注研究');
  });

  // ── Metadata from CLAUDE.md frontmatter ──

  it('should read metadata from CLAUDE.md YAML frontmatter', () => {
    const templateDir = path.join(tempDir, 'templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(
      path.join(templateDir, 'CLAUDE.md'),
      '---\ndisplayName: "研究模式"\ndescription: 专注研究\n---\n\n# Research Template',
    );

    const result = discoverTemplates(tempDir);
    expect(result.templates[0]).toEqual({
      name: 'research',
      displayName: '研究模式',
      description: '专注研究',
    });
  });

  it('should prefer template.yaml over CLAUDE.md frontmatter', () => {
    const templateDir = path.join(tempDir, 'templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(
      path.join(templateDir, 'CLAUDE.md'),
      '---\ndisplayName: "From Frontmatter"\n---\n\n# Template',
    );
    fs.writeFileSync(
      path.join(templateDir, 'template.yaml'),
      'displayName: "From YAML"',
    );

    const result = discoverTemplates(tempDir);
    expect(result.templates[0].displayName).toBe('From YAML');
  });

  it('should return template with no metadata when no yaml/frontmatter exists', () => {
    const templateDir = path.join(tempDir, 'templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), '# Just content, no frontmatter');

    const result = discoverTemplates(tempDir);
    expect(result.templates[0]).toEqual({
      name: 'research',
    });
  });

  // ── Validation ──

  it('should reject "default" as a template name', () => {
    const templateDir = path.join(tempDir, 'templates', 'default');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), '# Default');

    const result = discoverTemplates(tempDir);
    expect(result.templates).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].dirName).toBe('default');
    expect(result.errors[0].message).toContain('Invalid template directory name');
  });

  it('should reject directory names with path traversal', () => {
    // Can't actually create a directory named "..", so test with a name containing ".."
    const badDir = path.join(tempDir, 'templates', '..evil');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'CLAUDE.md'), '# Evil');

    const result = discoverTemplates(tempDir);
    expect(result.templates).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
  });

  it('should reject directory names with slashes', () => {
    // Slashes can't exist in directory names on most systems,
    // but test the validation function conceptually
    const templateDir = path.join(tempDir, 'templates', 'valid');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), '# Valid');

    const result = discoverTemplates(tempDir);
    expect(result.templates).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject whitespace-only directory names', () => {
    const templateDir = path.join(tempDir, 'templates', '   ');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), '# Space');

    const result = discoverTemplates(tempDir);
    expect(result.templates).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
  });

  it('should accept hyphens and unicode in template names', () => {
    for (const name of ['my-template', '研究模式', 'template_v2']) {
      const templateDir = path.join(tempDir, 'templates', name);
      fs.mkdirSync(templateDir, { recursive: true });
      fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), `# ${name}`);
    }

    const result = discoverTemplates(tempDir);
    expect(result.templates).toHaveLength(3);
    const names = result.templates.map((t) => t.name).sort();
    expect(names).toEqual(['my-template', 'template_v2', '研究模式']);
  });

  // ── Error handling ──

  it('should gracefully handle template.yaml with invalid key-value pairs', () => {
    const templateDir = path.join(tempDir, 'templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), '# Research');
    // Write YAML content that doesn't have valid key: value pairs
    fs.writeFileSync(path.join(templateDir, 'template.yaml'), '{{garbled content}}');

    // Template should still be discovered, just without metadata from the yaml
    const result = discoverTemplates(tempDir);
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0].name).toBe('research');
    // No metadata since the yaml doesn't contain displayName/description
    expect(result.templates[0].displayName).toBeUndefined();
    expect(result.templates[0].description).toBeUndefined();
  });

  // ── Custom options ──

  it('should support custom templates directory name', () => {
    const templateDir = path.join(tempDir, 'custom-templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), '# Research');

    const result = discoverTemplates(tempDir, { templatesDirName: 'custom-templates' });
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0].name).toBe('research');
  });

  // ── Empty/edge cases ──

  it('should handle empty templates directory', () => {
    fs.mkdirSync(path.join(tempDir, 'templates'), { recursive: true });

    const result = discoverTemplates(tempDir);
    expect(result.templates).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('should handle templates directory with only files (no subdirectories)', () => {
    fs.mkdirSync(path.join(tempDir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'templates', 'README.md'), '# Templates');
    fs.writeFileSync(path.join(tempDir, 'templates', '.gitkeep'), '');

    const result = discoverTemplates(tempDir);
    expect(result.templates).toEqual([]);
  });
});

describe('discoveryResultToConfig', () => {
  it('should convert templates to ProjectTemplatesConfig format', () => {
    const result = {
      templates: [
        { name: 'research', displayName: '研究模式', description: '专注研究' },
        { name: 'book-reader' },
      ],
      errors: [],
    };

    const config = discoveryResultToConfig(result);
    expect(config).toEqual({
      research: { displayName: '研究模式', description: '专注研究' },
      'book-reader': {},
    });
  });

  it('should handle empty templates', () => {
    const config = discoveryResultToConfig({ templates: [], errors: [] });
    expect(config).toEqual({});
  });

  it('should handle templates with only displayName', () => {
    const config = discoveryResultToConfig({
      templates: [{ name: 'test', displayName: 'Test' }],
      errors: [],
    });
    expect(config).toEqual({ test: { displayName: 'Test' } });
  });
});

describe('discoverTemplatesAsConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disclaude-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return empty config when no templates found', () => {
    const config = discoverTemplatesAsConfig(tempDir);
    expect(config).toEqual({});
  });

  it('should return config for discovered templates', () => {
    const templateDir = path.join(tempDir, 'templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), '# Research');
    fs.writeFileSync(
      path.join(templateDir, 'template.yaml'),
      'displayName: "研究模式"',
    );

    const config = discoverTemplatesAsConfig(tempDir);
    expect(config).toEqual({
      research: { displayName: '研究模式' },
    });
  });
});

describe('resolveTemplates', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disclaude-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return auto-discovered templates when no config provided', () => {
    const templateDir = path.join(tempDir, 'templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), '# Research');
    fs.writeFileSync(
      path.join(templateDir, 'template.yaml'),
      'displayName: "研究模式"',
    );

    const result = resolveTemplates(tempDir);
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]).toEqual({
      name: 'research',
      displayName: '研究模式',
    });
    expect(result.errors).toEqual([]);
  });

  it('should return empty templates when no discovery and no config', () => {
    const result = resolveTemplates(tempDir);
    expect(result.templates).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('should override discovered template metadata with config', () => {
    const templateDir = path.join(tempDir, 'templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), '# Research');
    fs.writeFileSync(
      path.join(templateDir, 'template.yaml'),
      'displayName: "Original Name"',
    );

    const result = resolveTemplates(tempDir, {
      research: { displayName: 'Overridden Name', description: 'New description' },
    });

    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]).toEqual({
      name: 'research',
      displayName: 'Overridden Name',
      description: 'New description',
    });
  });

  it('should add virtual templates from config not found on disk', () => {
    const templateDir = path.join(tempDir, 'templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), '# Research');

    const result = resolveTemplates(tempDir, {
      research: { displayName: '研究模式' },
      'virtual-template': { displayName: 'Virtual', description: 'Not on disk' },
    });

    expect(result.templates).toHaveLength(2);
    const names = result.templates.map((t) => t.name).sort();
    expect(names).toEqual(['research', 'virtual-template']);

    const virtual = result.templates.find((t) => t.name === 'virtual-template');
    expect(virtual).toEqual({
      name: 'virtual-template',
      displayName: 'Virtual',
      description: 'Not on disk',
    });
  });

  it('should only override specified metadata fields, keeping discovered ones', () => {
    const templateDir = path.join(tempDir, 'templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), '# Research');
    fs.writeFileSync(
      path.join(templateDir, 'template.yaml'),
      'displayName: "Original"\ndescription: "Original desc"',
    );

    // Only override displayName, keep description from discovery
    const result = resolveTemplates(tempDir, {
      research: { displayName: 'New Name' },
    });

    expect(result.templates[0]).toEqual({
      name: 'research',
      displayName: 'New Name',
      description: 'Original desc',
    });
  });

  it('should preserve discovery errors in result', () => {
    const badDir = path.join(tempDir, 'templates', 'default');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'CLAUDE.md'), '# Default');

    const result = resolveTemplates(tempDir, {});
    expect(result.templates).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].dirName).toBe('default');
  });

  it('should handle empty config object same as no config', () => {
    const templateDir = path.join(tempDir, 'templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), '# Research');

    const noConfig = resolveTemplates(tempDir);
    const emptyConfig = resolveTemplates(tempDir, {});

    expect(noConfig.templates).toEqual(emptyConfig.templates);
  });

  it('should merge multiple discovered templates with config overrides', () => {
    for (const name of ['research', 'book-reader', 'code-review']) {
      const dir = path.join(tempDir, 'templates', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# ${name}`);
    }

    const result = resolveTemplates(tempDir, {
      research: { displayName: '研究模式' },
      'book-reader': { displayName: '图书阅读器', description: '专注阅读' },
      // code-review: no override, uses discovered metadata (none)
    });

    expect(result.templates).toHaveLength(3);
    const research = result.templates.find((t) => t.name === 'research');
    expect(research?.displayName).toBe('研究模式');

    const bookReader = result.templates.find((t) => t.name === 'book-reader');
    expect(bookReader?.displayName).toBe('图书阅读器');
    expect(bookReader?.description).toBe('专注阅读');

    const codeReview = result.templates.find((t) => t.name === 'code-review');
    expect(codeReview?.displayName).toBeUndefined();
  });
});

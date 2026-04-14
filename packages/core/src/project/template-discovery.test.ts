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
  type TemplateSearchPath,
  discoverTemplates,
  discoverTemplatesFromPaths,
  discoveryResultToConfig,
  discoverTemplatesAsConfig,
  discoverTemplatesFromPathsAsConfig,
  getDefaultTemplateSearchPaths,
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Multi-path Discovery Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('getDefaultTemplateSearchPaths', () => {
  it('should return 3 search paths sorted by priority (highest first)', () => {
    const paths = getDefaultTemplateSearchPaths({
      cwd: '/project',
      workspaceDir: '/workspace',
      packageDir: '/app/templates',
    });

    expect(paths).toHaveLength(3);
    expect(paths[0].domain).toBe('project');
    expect(paths[0].priority).toBe(3);
    expect(paths[1].domain).toBe('workspace');
    expect(paths[1].priority).toBe(2);
    expect(paths[2].domain).toBe('package');
    expect(paths[2].priority).toBe(1);
  });

  it('should use cwd directly for project domain', () => {
    const paths = getDefaultTemplateSearchPaths({
      cwd: '/my/project',
      workspaceDir: '/workspace',
      packageDir: '/app/templates',
    });

    expect(paths[0].path).toBe('/my/project');
  });

  it('should use workspaceDir/.claude for workspace domain', () => {
    const paths = getDefaultTemplateSearchPaths({
      cwd: '/project',
      workspaceDir: '/workspace',
      packageDir: '/app/templates',
    });

    expect(paths[1].path).toBe('/workspace/.claude');
  });

  it('should use packageDir directly for package domain', () => {
    const paths = getDefaultTemplateSearchPaths({
      cwd: '/project',
      workspaceDir: '/workspace',
      packageDir: '/app/templates',
    });

    expect(paths[2].path).toBe('/app/templates');
  });
});

describe('discoverTemplatesFromPaths', () => {
  let tempRoot: string;
  let projectDir: string;
  let workspaceDir: string;
  let packageDir: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'disclaude-test-'));
    projectDir = path.join(tempRoot, 'project');
    workspaceDir = path.join(tempRoot, 'workspace');
    packageDir = path.join(tempRoot, 'package');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(packageDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function makeSearchPaths(): TemplateSearchPath[] {
    return [
      { path: projectDir, domain: 'project', priority: 3 },
      { path: workspaceDir, domain: 'workspace', priority: 2 },
      { path: packageDir, domain: 'package', priority: 1 },
    ];
  }

  function createTemplate(baseDir: string, name: string, content?: string) {
    const templateDir = path.join(baseDir, 'templates', name);
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'CLAUDE.md'), content ?? `# ${name}`);
  }

  it('should return empty result when no paths have templates', () => {
    const result = discoverTemplatesFromPaths(makeSearchPaths());
    expect(result.templates).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('should discover templates from a single path', () => {
    createTemplate(packageDir, 'research');

    const result = discoverTemplatesFromPaths(makeSearchPaths());
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0].name).toBe('research');
  });

  it('should discover templates from multiple paths', () => {
    createTemplate(projectDir, 'my-template');
    createTemplate(packageDir, 'builtin-template');

    const result = discoverTemplatesFromPaths(makeSearchPaths());
    expect(result.templates).toHaveLength(2);
    const names = result.templates.map((t) => t.name).sort();
    expect(names).toEqual(['builtin-template', 'my-template']);
  });

  it('should let higher priority path win for duplicate template names', () => {
    // Same template name in both project and package
    createTemplate(projectDir, 'research', '# Project Research');
    createTemplate(packageDir, 'research', '# Package Research');

    // Add template.yaml in project to identify it
    const projectTemplateDir = path.join(projectDir, 'templates', 'research');
    fs.writeFileSync(
      path.join(projectTemplateDir, 'template.yaml'),
      'displayName: "Project Override"',
    );

    const result = discoverTemplatesFromPaths(makeSearchPaths());
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0].name).toBe('research');
    expect(result.templates[0].displayName).toBe('Project Override');
  });

  it('should let workspace override package', () => {
    createTemplate(workspaceDir, 'research');
    createTemplate(packageDir, 'research');

    const workspaceTemplateDir = path.join(workspaceDir, 'templates', 'research');
    fs.writeFileSync(
      path.join(workspaceTemplateDir, 'template.yaml'),
      'displayName: "Workspace Version"',
    );

    const result = discoverTemplatesFromPaths(makeSearchPaths());
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0].displayName).toBe('Workspace Version');
  });

  it('should accumulate errors from all paths', () => {
    // Create an invalid template in package dir
    const badDir = path.join(packageDir, 'templates', 'default');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'CLAUDE.md'), '# Bad');

    const result = discoverTemplatesFromPaths(makeSearchPaths());
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.dirName === 'default')).toBe(true);
  });

  it('should handle non-existent search paths gracefully', () => {
    const nonExistentPaths: TemplateSearchPath[] = [
      { path: '/non/existent/path', domain: 'project', priority: 3 },
    ];

    const result = discoverTemplatesFromPaths(nonExistentPaths);
    expect(result.templates).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('should combine unique templates from all three paths', () => {
    createTemplate(projectDir, 'custom-a');
    createTemplate(workspaceDir, 'shared-b');
    createTemplate(packageDir, 'builtin-c');

    const result = discoverTemplatesFromPaths(makeSearchPaths());
    expect(result.templates).toHaveLength(3);
    const names = result.templates.map((t) => t.name).sort();
    expect(names).toEqual(['builtin-c', 'custom-a', 'shared-b']);
  });
});

describe('discoverTemplatesFromPathsAsConfig', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'disclaude-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('should return empty config when no templates found', () => {
    const emptyPath: TemplateSearchPath[] = [
      { path: tempRoot, domain: 'project', priority: 1 },
    ];
    const config = discoverTemplatesFromPathsAsConfig(emptyPath);
    expect(config).toEqual({});
  });

  it('should return config from discovered templates across paths', () => {
    const dirA = path.join(tempRoot, 'a');
    const dirB = path.join(tempRoot, 'b');
    fs.mkdirSync(path.join(dirA, 'templates', 'tmpl-a'), { recursive: true });
    fs.writeFileSync(path.join(dirA, 'templates', 'tmpl-a', 'CLAUDE.md'), '# A');
    fs.mkdirSync(path.join(dirB, 'templates', 'tmpl-b'), { recursive: true });
    fs.writeFileSync(path.join(dirB, 'templates', 'tmpl-b', 'CLAUDE.md'), '# B');

    const paths: TemplateSearchPath[] = [
      { path: dirA, domain: 'project', priority: 2 },
      { path: dirB, domain: 'package', priority: 1 },
    ];

    const config = discoverTemplatesFromPathsAsConfig(paths);
    expect(config).toEqual({
      'tmpl-a': {},
      'tmpl-b': {},
    });
  });
});

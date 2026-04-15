/**
 * Tests for createCwdProvider factory function.
 *
 * @see Issue #2227 (Sub-Issue E — integration)
 */

import { describe, it, expect } from 'vitest';
import { createCwdProvider, type ActiveProjectResolver } from './cwd-provider.js';
import type { ProjectContextConfig } from './types.js';

describe('createCwdProvider', () => {
  it('returns undefined when no resolver is provided', () => {
    const provider = createCwdProvider();
    expect(provider('oc_test123')).toBeUndefined();
  });

  it('returns undefined when resolver returns undefined', () => {
    const resolver: ActiveProjectResolver = {
      getActive: () => undefined,
    };
    const provider = createCwdProvider(resolver);
    expect(provider('oc_no_project')).toBeUndefined();
  });

  it('returns workingDir when resolver returns a project', () => {
    const project: ProjectContextConfig = {
      name: 'research',
      templateName: 'research',
      workingDir: '/workspace/projects/research',
    };
    const resolver: ActiveProjectResolver = {
      getActive: () => project,
    };
    const provider = createCwdProvider(resolver);
    expect(provider('oc_with_project')).toBe('/workspace/projects/research');
  });

  it('returns workingDir dynamically for different chatIds', () => {
    const projects = new Map<string, ProjectContextConfig>([
      ['oc_chat1', { name: 'research', templateName: 'research', workingDir: '/workspace/projects/research' }],
      ['oc_chat2', { name: 'coding', templateName: 'coding', workingDir: '/workspace/projects/coding' }],
    ]);
    const resolver: ActiveProjectResolver = {
      getActive: (chatId) => projects.get(chatId),
    };
    const provider = createCwdProvider(resolver);

    expect(provider('oc_chat1')).toBe('/workspace/projects/research');
    expect(provider('oc_chat2')).toBe('/workspace/projects/coding');
    expect(provider('oc_unknown')).toBeUndefined();
  });

  it('reflects state changes when resolver is mutable', () => {
    const binding = new Map<string, ProjectContextConfig>();
    const resolver: ActiveProjectResolver = {
      getActive: (chatId) => binding.get(chatId),
    };
    const provider = createCwdProvider(resolver);

    // Initially no project
    expect(provider('oc_chat1')).toBeUndefined();

    // Bind a project
    binding.set('oc_chat1', {
      name: 'research',
      templateName: 'research',
      workingDir: '/workspace/projects/research',
    });
    expect(provider('oc_chat1')).toBe('/workspace/projects/research');

    // Reset (remove binding)
    binding.delete('oc_chat1');
    expect(provider('oc_chat1')).toBeUndefined();
  });

  it('returns a function that matches CwdProvider type signature', () => {
    const provider = createCwdProvider();
    expect(typeof provider).toBe('function');
    expect(provider.length).toBe(1); // accepts 1 parameter (chatId)
  });
});

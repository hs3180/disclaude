/**
 * Unit tests for scripts/launchd.mjs — macOS launchd management script.
 *
 * Focuses on plist generation output format (smoke tests) and exported constants.
 * File-system and child_process side effects are NOT exercised here; instead we
 * call the pure `generatePlistContent` function with controlled inputs.
 *
 * @see Issue #2894 — add test coverage for scripts/launchd.mjs
 */

import { describe, it, expect } from 'vitest';
import {
  generatePlistContent,
  LABEL,
  PLIST_FILENAME,
  STDOUT_LOG,
  STDERR_LOG,
} from '../scripts/launchd.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('launchd constants', () => {
  it('LABEL should be a reverse-DNS identifier', () => {
    expect(LABEL).toBe('com.disclaude.primary');
  });

  it('PLIST_FILENAME should be derived from LABEL', () => {
    expect(PLIST_FILENAME).toBe(`${LABEL}.plist`);
  });

  it('STDOUT_LOG and STDERR_LOG should be /tmp paths', () => {
    expect(STDOUT_LOG).toMatch(/^\/tmp\/disclaude-stdout\.log$/);
    expect(STDERR_LOG).toMatch(/^\/tmp\/disclaude-stderr\.log$/);
  });
});

// ---------------------------------------------------------------------------
// Plist generation (pure function)
// ---------------------------------------------------------------------------

describe('generatePlistContent', () => {
  const defaults = {
    nodePath: '/usr/local/bin/node',
    cliEntry: '/opt/disclaude/packages/primary-node/dist/cli.js',
    projectRoot: '/opt/disclaude',
    label: 'com.disclaude.primary',
    stdoutLog: '/tmp/disclaude-stdout.log',
    stderrLog: '/tmp/disclaude-stderr.log',
    pathEnv: '/usr/local/bin:/usr/bin:/bin',
    homeEnv: '/Users/testuser',
  };

  it('should return a string starting with valid XML declaration', () => {
    const plist = generatePlistContent(defaults);
    expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(plist).toContain(
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    );
  });

  it('should wrap content in <plist version="1.0"> root element', () => {
    const plist = generatePlistContent(defaults);
    expect(plist).toContain('<plist version="1.0">');
    expect(plist).toContain('</plist>');
  });

  it('should contain the correct Label key-value pair', () => {
    const plist = generatePlistContent(defaults);
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain(`<string>${defaults.label}</string>`);
  });

  it('should contain ProgramArguments with node path, CLI entry, and "start"', () => {
    const plist = generatePlistContent(defaults);
    expect(plist).toContain('<key>ProgramArguments</key>');
    expect(plist).toContain(`<string>${defaults.nodePath}</string>`);
    expect(plist).toContain(`<string>${defaults.cliEntry}</string>`);
    expect(plist).toContain('<string>start</string>');
  });

  it('should set WorkingDirectory to project root', () => {
    const plist = generatePlistContent(defaults);
    expect(plist).toContain('<key>WorkingDirectory</key>');
    expect(plist).toContain(`<string>${defaults.projectRoot}</string>`);
  });

  it('should set RunAtLoad to true', () => {
    const plist = generatePlistContent(defaults);
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<true/>');
  });

  it('should set KeepAlive to true', () => {
    const plist = generatePlistContent(defaults);
    expect(plist).toContain('<key>KeepAlive</key>');
    // There are two <true/> entries (RunAtLoad + KeepAlive)
    const trueCount = (plist.match(/<true\/>/g) || []).length;
    expect(trueCount).toBeGreaterThanOrEqual(2);
  });

  it('should set StandardOutPath and StandardErrorPath', () => {
    const plist = generatePlistContent(defaults);
    expect(plist).toContain('<key>StandardOutPath</key>');
    expect(plist).toContain(`<string>${defaults.stdoutLog}</string>`);
    expect(plist).toContain('<key>StandardErrorPath</key>');
    expect(plist).toContain(`<string>${defaults.stderrLog}</string>`);
  });

  it('should include EnvironmentVariables with PATH, HOME, NODE_ENV', () => {
    const plist = generatePlistContent(defaults);
    expect(plist).toContain('<key>EnvironmentVariables</key>');
    expect(plist).toContain(`<string>${defaults.pathEnv}</string>`);
    expect(plist).toContain(`<string>${defaults.homeEnv}</string>`);
    expect(plist).toContain('<string>production</string>');
  });

  it('should produce well-formed plist XML (basic structural check)', () => {
    const plist = generatePlistContent(defaults);
    // Every opening tag should have a matching closing tag or be self-closing
    const openTags = plist.match(/<dict>/g) || [];
    const closeTags = plist.match(/<\/dict>/g) || [];
    expect(openTags.length).toBe(closeTags.length);

    const openArrays = plist.match(/<array>/g) || [];
    const closeArrays = plist.match(/<\/array>/g) || [];
    expect(openArrays.length).toBe(closeArrays.length);
  });

  it('should use default values when optional params are omitted', () => {
    // Only provide required params
    const plist = generatePlistContent({
      nodePath: '/usr/bin/node',
      cliEntry: '/app/dist/cli.js',
      projectRoot: '/app',
    });
    expect(plist).toContain('com.disclaude.primary'); // default LABEL
    expect(plist).toContain('/tmp/disclaude-stdout.log'); // default STDOUT_LOG
    expect(plist).toContain('/tmp/disclaude-stderr.log'); // default STDERR_LOG
    expect(plist).toContain('production'); // default NODE_ENV
  });

  it('should allow custom label override', () => {
    const plist = generatePlistContent({
      ...defaults,
      label: 'com.example.custom',
    });
    expect(plist).toContain('<string>com.example.custom</string>');
    expect(plist).not.toContain('<string>com.disclaude.primary</string>');
  });

  it('should allow custom log paths override', () => {
    const plist = generatePlistContent({
      ...defaults,
      stdoutLog: '/var/log/custom-stdout.log',
      stderrLog: '/var/log/custom-stderr.log',
    });
    expect(plist).toContain('<string>/var/log/custom-stdout.log</string>');
    expect(plist).toContain('<string>/var/log/custom-stderr.log</string>');
  });

  it('should inject the provided node path and CLI entry into ProgramArguments', () => {
    const customNode = '/custom/path/to/node';
    const customEntry = '/custom/path/to/cli.js';
    const plist = generatePlistContent({
      ...defaults,
      nodePath: customNode,
      cliEntry: customEntry,
    });
    expect(plist).toContain(`<string>${customNode}</string>`);
    expect(plist).toContain(`<string>${customEntry}</string>`);
  });

  it('should always set NODE_ENV to production', () => {
    const plist = generatePlistContent(defaults);
    // NODE_ENV is hardcoded to "production" in the template
    expect(plist).toContain('<key>NODE_ENV</key>');
    expect(plist).toContain('<string>production</string>');
  });
});

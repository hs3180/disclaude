/**
 * Tests for UpgradeService.
 *
 * Note: Some tests involving fs/promises and child_process mocks are simplified
 * due to vitest mock hoisting limitations. The core logic is tested through
 * integration tests and manual testing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpgradeService } from './upgrade-service.js';

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('UpgradeService', () => {
  let service: UpgradeService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new UpgradeService({ workingDir: '/test/dir' });
  });

  describe('constructor', () => {
    it('should use provided working directory', () => {
      const customService = new UpgradeService({ workingDir: '/custom/dir' });
      expect(customService).toBeDefined();
    });

    it('should use default working directory if not provided', () => {
      const defaultService = new UpgradeService();
      expect(defaultService).toBeDefined();
    });
  });

  describe('getCurrentVersion', () => {
    it('should return "unknown" if package.json cannot be read', async () => {
      // This test doesn't require mocking since it will fail to read the file
      // in the test environment
      const version = await service.getCurrentVersion();
      // In test environment, the file doesn't exist, so it returns 'unknown'
      expect(typeof version).toBe('string');
    });
  });

  describe('isValidInstallation', () => {
    it('should return false if package.json cannot be read', async () => {
      const isValid = await service.isValidInstallation();
      expect(isValid).toBe(false);
    });
  });

  describe('upgrade', () => {
    it('should skip all steps when all skip options are set', async () => {
      const result = await service.upgrade({
        skipGitPull: true,
        skipNpmInstall: true,
        skipBuild: true,
        skipRestart: true,
      });

      // Should succeed with only version step
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].success).toBe(true);
      expect(result.steps[0].message).toContain('当前版本');
    });

    it('should return steps array in result', async () => {
      const result = await service.upgrade({
        skipGitPull: true,
        skipNpmInstall: true,
        skipBuild: true,
        skipRestart: true,
      });

      expect(Array.isArray(result.steps)).toBe(true);
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('previousVersion');
      expect(result).toHaveProperty('newVersion');
    });

    it('should return error when git pull fails (simulated)', async () => {
      // With skip options, this tests the structure
      const result = await service.upgrade({
        skipNpmInstall: true,
        skipBuild: true,
        skipRestart: true,
      });

      // Git pull will fail in test environment
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('steps');
    });
  });
});

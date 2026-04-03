/**
 * Unit tests for TCC-Safe Spawn utility (Issue #1957)
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  isMacOS,
  detectPm2Environment,
  getTCCEnvironmentInfo,
  spawnTCCSafe,
  checkMicrophonePermission,
  diagnoseTCCMicrophoneIssue,
} from './tcc-safe-spawn.js';

describe('tcc-safe-spawn', () => {
  describe('isMacOS', () => {
    it('should return true on darwin platform', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      expect(isMacOS()).toBe(true);
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('should return false on linux platform', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux' });
      expect(isMacOS()).toBe(false);
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('should return false on win32 platform', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(isMacOS()).toBe(false);
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });
  });

  describe('detectPm2Environment', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      // Restore environment
      process.env = { ...originalEnv };
    });

    it('should detect PM2 when multiple PM2 env vars are set', () => {
      process.env.pm_id = '0';
      process.env.PM2_HOME = '/home/user/.pm2';
      process.env.pm_uptime = '1234567890';

      const result = detectPm2Environment();
      expect(result.isPm2).toBe(true);
    });

    it('should not detect PM2 when less than 2 env vars are set', () => {
      process.env.pm_id = '0';
      delete process.env.PM2_HOME;
      delete process.env.pm_uptime;

      const result = detectPm2Environment();
      expect(result.isPm2).toBe(false);
    });

    it('should not detect PM2 when no env vars are set', () => {
      delete process.env.pm_id;
      delete process.env.PM2_HOME;
      delete process.env.pm_uptime;

      const result = detectPm2Environment();
      expect(result.isPm2).toBe(false);
    });

    it('should extract PM2 app name from env', () => {
      process.env.pm_id = '0';
      process.env.PM2_HOME = '/home/user/.pm2';
      process.env.name = 'disclaude-primary';

      const result = detectPm2Environment();
      expect(result.isPm2).toBe(true);
      expect(result.name).toBe('disclaude-primary');
    });
  });

  describe('getTCCEnvironmentInfo', () => {
    const originalPlatform = process.platform;
    const originalEnv = { ...process.env };

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      process.env = { ...originalEnv };
    });

    it('should return unavailable on non-macOS platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });

      const result = getTCCEnvironmentInfo();
      expect(result.isMacOS).toBe(false);
      expect(result.isPm2).toBe(false);
      expect(result.tccSafeAvailable).toBe(false);
      expect(result.unavailableReason).toContain('only available on macOS');
    });

    it('should return unavailable on macOS without PM2', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      delete process.env.pm_id;
      delete process.env.PM2_HOME;

      const result = getTCCEnvironmentInfo();
      expect(result.isMacOS).toBe(true);
      expect(result.isPm2).toBe(false);
      expect(result.tccSafeAvailable).toBe(false);
      expect(result.unavailableReason).toContain('Not running under PM2');
    });

    it('should return available on macOS with PM2', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      process.env.pm_id = '0';
      process.env.PM2_HOME = '/home/user/.pm2';
      process.env.pm_uptime = '1234567890';
      process.env.name = 'disclaude-primary';

      const result = getTCCEnvironmentInfo();
      expect(result.isMacOS).toBe(true);
      expect(result.isPm2).toBe(true);
      expect(result.tccSafeAvailable).toBe(true);
      expect(result.pm2Name).toBe('disclaude-primary');
    });
  });

  describe('spawnTCCSafe', () => {
    const originalPlatform = process.platform;
    const originalEnv = { ...process.env };

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      process.env = { ...originalEnv };
    });

    it('should use direct spawn on non-macOS platforms', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      delete process.env.pm_id;
      delete process.env.PM2_HOME;

      const result = await spawnTCCSafe('echo', ['hello'], { debug: false });
      expect(result.success).toBe(true);
      expect(result.usedTCCSafeMode).toBe(false);
      expect(result.output).toContain('hello');
    });

    it('should use direct spawn on macOS without PM2', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      delete process.env.pm_id;
      delete process.env.PM2_HOME;

      const result = await spawnTCCSafe('echo', ['hello'], { debug: false });
      expect(result.success).toBe(true);
      expect(result.usedTCCSafeMode).toBe(false);
    });

    it('should handle command failure', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });

      const result = await spawnTCCSafe('false', [], { debug: false });
      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
    });

    it('should respect timeout option', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });

      const result = await spawnTCCSafe('sleep', ['100'], {
        timeout: 500,
        debug: false,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });
  });

  describe('checkMicrophonePermission', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('should return unsupported on non-macOS platforms', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });

      const result = await checkMicrophonePermission();
      expect(result.status).toBe('unsupported');
      expect(result.detail).toContain('only available on macOS');
    });
  });

  describe('diagnoseTCCMicrophoneIssue', () => {
    const originalPlatform = process.platform;
    const originalEnv = { ...process.env };

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      process.env = { ...originalEnv };
    });

    it('should provide recommendations for non-macOS platforms', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      delete process.env.pm_id;
      delete process.env.PM2_HOME;

      const result = await diagnoseTCCMicrophoneIssue();
      expect(result.environment.isMacOS).toBe(false);
      expect(result.recommendations.length).toBeGreaterThan(0);
      expect(result.recommendations[0]).toContain('TCC is a macOS-only feature');
    });

    it('should provide recommendations for macOS without PM2', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      delete process.env.pm_id;
      delete process.env.PM2_HOME;

      const result = await diagnoseTCCMicrophoneIssue();
      expect(result.environment.isMacOS).toBe(true);
      expect(result.environment.isPm2).toBe(false);
      expect(result.recommendations.length).toBeGreaterThan(0);
      expect(result.recommendations[0]).toContain('Not running under PM2');
    });
  });
});

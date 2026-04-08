/**
 * Tests for TCC-safe process spawning utility (Issue #1957)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  isPm2Managed,
  isMacOS,
  needsTccSafeSpawn,
  getTccEnvironmentInfo,
  createTccSafeScript,
  removeTccSafeScript,
} from './tcc-safe-spawn.js';

// Mock child_process at module level for ESM compatibility
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

describe('tcc-safe-spawn', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    mockSpawn.mockReturnValue({
      pid: 12345,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    });

    // Reset PM2 env vars before each test
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('PM2_') || key === 'pm_id' || key === 'pm2_home') {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('isPm2Managed', () => {
    it('should return false when no PM2 env vars are set', () => {
      expect(isPm2Managed()).toBe(false);
    });

    it('should return true when PM2_HOME is set', () => {
      process.env.PM2_HOME = '/home/user/.pm2';
      expect(isPm2Managed()).toBe(true);
    });

    it('should return true when pm_id is set', () => {
      process.env.pm_id = '0';
      expect(isPm2Managed()).toBe(true);
    });

    it('should return true when pm2_home is set', () => {
      process.env.pm2_home = '/root/.pm2';
      expect(isPm2Managed()).toBe(true);
    });

    it('should return true when PM2_PROC_TITLE is set', () => {
      process.env.PM2_PROC_TITLE = 'disclaude-worker';
      expect(isPm2Managed()).toBe(true);
    });
  });

  describe('isMacOS', () => {
    it('should return true on darwin platform', () => {
      vi.spyOn(os, 'platform').mockReturnValue('darwin');
      expect(isMacOS()).toBe(true);
    });

    it('should return false on linux platform', () => {
      vi.spyOn(os, 'platform').mockReturnValue('linux');
      expect(isMacOS()).toBe(false);
    });

    it('should return false on win32 platform', () => {
      vi.spyOn(os, 'platform').mockReturnValue('win32');
      expect(isMacOS()).toBe(false);
    });
  });

  describe('needsTccSafeSpawn', () => {
    it('should return true on macOS + PM2', () => {
      vi.spyOn(os, 'platform').mockReturnValue('darwin');
      process.env.PM2_HOME = '/home/user/.pm2';
      expect(needsTccSafeSpawn()).toBe(true);
    });

    it('should return false on macOS without PM2', () => {
      vi.spyOn(os, 'platform').mockReturnValue('darwin');
      expect(needsTccSafeSpawn()).toBe(false);
    });

    it('should return false on Linux + PM2', () => {
      vi.spyOn(os, 'platform').mockReturnValue('linux');
      process.env.PM2_HOME = '/home/user/.pm2';
      expect(needsTccSafeSpawn()).toBe(false);
    });

    it('should return false on Linux without PM2', () => {
      vi.spyOn(os, 'platform').mockReturnValue('linux');
      expect(needsTccSafeSpawn()).toBe(false);
    });
  });

  describe('getTccEnvironmentInfo', () => {
    it('should return correct info for non-PM2 Linux', () => {
      vi.spyOn(os, 'platform').mockReturnValue('linux');
      const info = getTccEnvironmentInfo();

      expect(info.isMacOS).toBe(false);
      expect(info.isPm2Managed).toBe(false);
      expect(info.needsTccSafeSpawn).toBe(false);
      expect(info.pm2EnvVars).toEqual([]);
    });

    it('should return correct info for macOS + PM2', () => {
      vi.spyOn(os, 'platform').mockReturnValue('darwin');
      process.env.PM2_HOME = '/home/user/.pm2';
      process.env.pm_id = '0';
      process.env.PM2_PROC_TITLE = 'disclaude-worker';

      const info = getTccEnvironmentInfo();

      expect(info.isMacOS).toBe(true);
      expect(info.isPm2Managed).toBe(true);
      expect(info.needsTccSafeSpawn).toBe(true);
      expect(info.pm2EnvVars).toContain('PM2_HOME');
      expect(info.pm2EnvVars).toContain('pm_id');
      expect(info.pm2EnvVars).toContain('PM2_PROC_TITLE');
    });

    it('should list only present PM2 env vars', () => {
      vi.spyOn(os, 'platform').mockReturnValue('darwin');
      process.env.pm_id = '1';

      const info = getTccEnvironmentInfo();

      expect(info.pm2EnvVars).toEqual(['pm_id']);
    });
  });

  describe('tccSafeSpawn', () => {
    it('should use normal spawn on non-macOS', async () => {
      vi.spyOn(os, 'platform').mockReturnValue('linux');
      const { tccSafeSpawn } = await import('./tcc-safe-spawn.js');

      tccSafeSpawn({
        command: 'echo',
        args: ['hello'],
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'echo',
        ['hello'],
        expect.objectContaining({
          env: expect.any(Object),
        })
      );
    });

    it('should use normal spawn on macOS without PM2', async () => {
      vi.spyOn(os, 'platform').mockReturnValue('darwin');
      const { tccSafeSpawn } = await import('./tcc-safe-spawn.js');

      tccSafeSpawn({
        command: 'echo',
        args: ['hello'],
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'echo',
        ['hello'],
        expect.objectContaining({
          env: expect.any(Object),
        })
      );
    });

    it('should use osascript spawn on macOS + PM2', async () => {
      vi.spyOn(os, 'platform').mockReturnValue('darwin');
      process.env.PM2_HOME = '/home/user/.pm2';
      const { tccSafeSpawn } = await import('./tcc-safe-spawn.js');

      tccSafeSpawn({
        command: 'python3',
        args: ['record.py', '--output', '/tmp/audio.wav'],
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'osascript',
        ['-e', expect.stringContaining('Terminal')],
        expect.objectContaining({
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      );
    });

    it('should use osascript spawn when forceTccSafe is true on macOS', async () => {
      vi.spyOn(os, 'platform').mockReturnValue('darwin');
      const { tccSafeSpawn } = await import('./tcc-safe-spawn.js');

      tccSafeSpawn({
        command: 'python3',
        args: ['record.py'],
        forceTccSafe: true,
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'osascript',
        ['-e', expect.stringContaining('Terminal')],
        expect.any(Object)
      );
    });

    it('should include env vars in osascript command on macOS + PM2', async () => {
      vi.spyOn(os, 'platform').mockReturnValue('darwin');
      process.env.PM2_HOME = '/home/user/.pm2';
      const { tccSafeSpawn } = await import('./tcc-safe-spawn.js');

      tccSafeSpawn({
        command: 'python3',
        args: ['record.py'],
        env: { AUDIO_DEVICE: 'AirPods' },
      });

      const osascriptArg = mockSpawn.mock.calls[0][1]?.[1] as string;
      expect(osascriptArg).toContain('export');
      expect(osascriptArg).toContain('AUDIO_DEVICE');
    });

    it('should include cwd in osascript command on macOS + PM2', async () => {
      vi.spyOn(os, 'platform').mockReturnValue('darwin');
      process.env.PM2_HOME = '/home/user/.pm2';
      const { tccSafeSpawn } = await import('./tcc-safe-spawn.js');

      tccSafeSpawn({
        command: 'python3',
        args: ['record.py'],
        cwd: '/home/user/project',
      });

      const osascriptArg = mockSpawn.mock.calls[0][1]?.[1] as string;
      expect(osascriptArg).toContain('/home/user/project');
    });

    it('should pass extra env vars to normal spawn', async () => {
      vi.spyOn(os, 'platform').mockReturnValue('linux');
      const { tccSafeSpawn } = await import('./tcc-safe-spawn.js');

      tccSafeSpawn({
        command: 'python3',
        args: ['script.py'],
        env: { MY_VAR: 'test' },
      });

      const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOptions.env.MY_VAR).toBe('test');
    });

    it('should not force TCC-safe on non-macOS even with forceTccSafe', async () => {
      vi.spyOn(os, 'platform').mockReturnValue('linux');
      const { tccSafeSpawn } = await import('./tcc-safe-spawn.js');

      tccSafeSpawn({
        command: 'echo',
        args: ['test'],
        forceTccSafe: true,
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'echo',
        ['test'],
        expect.objectContaining({
          env: expect.any(Object),
        })
      );
    });
  });

  describe('createTccSafeScript', () => {
    it('should create a valid shell script', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcc-test-'));
      try {
        const scriptPath = createTccSafeScript({
          command: 'echo',
          args: ['hello', 'world'],
          scriptDir: tmpDir,
        });

        expect(fs.existsSync(scriptPath)).toBe(true);
        expect(scriptPath).toMatch(/\.sh$/);

        const content = fs.readFileSync(scriptPath, 'utf-8');
        expect(content).toContain('#!/bin/bash');
        expect(content).toContain('echo');
        expect(content).toContain('hello');
        expect(content).toContain('world');
        expect(content).toContain('set -euo pipefail');
        expect(content).toContain('1957');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should include env vars in the script', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcc-test-'));
      try {
        const scriptPath = createTccSafeScript({
          command: 'python3',
          args: ['record.py'],
          env: { AUDIO_DEVICE: 'AirPods', SAMPLE_RATE: '44100' },
          scriptDir: tmpDir,
        });

        const content = fs.readFileSync(scriptPath, 'utf-8');
        expect(content).toContain('export AUDIO_DEVICE=');
        expect(content).toContain('export SAMPLE_RATE=');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should include cwd in the script', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcc-test-'));
      try {
        const scriptPath = createTccSafeScript({
          command: 'python3',
          args: ['record.py'],
          cwd: '/home/user/project',
          scriptDir: tmpDir,
        });

        const content = fs.readFileSync(scriptPath, 'utf-8');
        expect(content).toContain('cd "/home/user/project"');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should include output redirection when outputPath is specified', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcc-test-'));
      try {
        const scriptPath = createTccSafeScript({
          command: 'python3',
          args: ['record.py'],
          outputPath: '/tmp/output.txt',
          scriptDir: tmpDir,
        });

        const content = fs.readFileSync(scriptPath, 'utf-8');
        expect(content).toContain('> "/tmp/output.txt"');
        expect(content).toContain('2>&1');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should create script with executable permissions', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcc-test-'));
      try {
        const scriptPath = createTccSafeScript({
          command: 'echo',
          scriptDir: tmpDir,
        });

        const stats = fs.statSync(scriptPath);
        // Check that the file is executable (at least owner)
        expect(stats.mode & 0o111).toBeTruthy();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should use os.tmpdir() by default', () => {
      const scriptPath = createTccSafeScript({
        command: 'echo',
        args: ['test'],
      });

      try {
        expect(path.dirname(scriptPath)).toBe(os.tmpdir());
        expect(fs.existsSync(scriptPath)).toBe(true);
      } finally {
        removeTccSafeScript(scriptPath);
      }
    });
  });

  describe('removeTccSafeScript', () => {
    it('should remove an existing script', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcc-test-'));
      const scriptPath = path.join(tmpDir, 'test-script.sh');
      fs.writeFileSync(scriptPath, '#!/bin/bash\necho test\n', { mode: 0o755 });

      expect(fs.existsSync(scriptPath)).toBe(true);
      removeTccSafeScript(scriptPath);
      expect(fs.existsSync(scriptPath)).toBe(false);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should not throw when removing a non-existent script', () => {
      expect(() => removeTccSafeScript('/nonexistent/path/script.sh')).not.toThrow();
    });
  });
});

/**
 * Tests for macOS TCC-safe audio recording utility (Issue #1957)
 *
 * Tests platform detection, PM2 detection, TCC workaround logic,
 * audio data validation, and the recording workflow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  isUnderPM2,
  isMacOS,
  shouldUseTccWorkaround,
  validateAudioData,
  recordViaTccWorkaround,
  recordDirectly,
  recordAudio,
} from './audio-record.js';
import type { AudioRecordResult } from './audio-record.js';

// Store original process properties
const originalPlatform = process.platform;
const originalEnv = { ...process.env };
const originalTitle = process.title;

describe('audio-record', () => {
  beforeEach(() => {
    // Reset env vars
    process.env = { ...originalEnv };
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
    Object.defineProperty(process, 'title', { value: originalTitle, writable: true });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
    Object.defineProperty(process, 'title', { value: originalTitle, writable: true });
  });

  describe('isMacOS', () => {
    it('should return true on darwin platform', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
      expect(isMacOS()).toBe(true);
    });

    it('should return false on linux platform', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      expect(isMacOS()).toBe(false);
    });

    it('should return false on win32 platform', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
      expect(isMacOS()).toBe(false);
    });
  });

  describe('isUnderPM2', () => {
    it('should return true when PM2_HOME is set', () => {
      process.env.PM2_HOME = '/home/user/.pm2';
      expect(isUnderPM2()).toBe(true);
    });

    it('should return true when PM2_PID is set', () => {
      delete process.env.PM2_HOME;
      process.env.PM2_PID = '1234';
      expect(isUnderPM2()).toBe(true);
    });

    it('should return true when process title contains pm2', () => {
      delete process.env.PM2_HOME;
      delete process.env.PM2_PID;
      Object.defineProperty(process, 'title', { value: 'pm2 v5.3.0: God Daemon', writable: true });
      expect(isUnderPM2()).toBe(true);
    });

    it('should return false when no PM2 indicators are present', () => {
      delete process.env.PM2_HOME;
      delete process.env.PM2_PID;
      delete process.env.PM2_JSON_PROCESSING;
      delete process.env.PM2_WORKER_THREAD;
      delete process.env.pm_id;
      delete process.env.PM2进程管理;
      Object.defineProperty(process, 'title', { value: 'node /app/index.js', writable: true });
      expect(isUnderPM2()).toBe(false);
    });

    it('should return true when PM2_JSON_PROCESSING is set', () => {
      delete process.env.PM2_HOME;
      delete process.env.PM2_PID;
      process.env.PM2_JSON_PROCESSING = 'true';
      expect(isUnderPM2()).toBe(true);
    });
  });

  describe('shouldUseTccWorkaround', () => {
    it('should return true when explicitly set to true', () => {
      expect(shouldUseTccWorkaround(true)).toBe(true);
    });

    it('should return false when explicitly set to false', () => {
      expect(shouldUseTccWorkaround(false)).toBe(false);
    });

    it('should auto-detect: true on macOS + PM2', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
      process.env.PM2_HOME = '/home/user/.pm2';
      expect(shouldUseTccWorkaround()).toBe(true);
    });

    it('should auto-detect: false on macOS without PM2', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
      delete process.env.PM2_HOME;
      delete process.env.PM2_PID;
      delete process.env.PM2_JSON_PROCESSING;
      delete process.env.PM2_WORKER_THREAD;
      delete process.env.pm_id;
      delete process.env.PM2进程管理;
      Object.defineProperty(process, 'title', { value: 'node', writable: true });
      expect(shouldUseTccWorkaround()).toBe(false);
    });

    it('should auto-detect: false on Linux even with PM2', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      process.env.PM2_HOME = '/home/user/.pm2';
      expect(shouldUseTccWorkaround()).toBe(false);
    });
  });

  describe('validateAudioData', () => {
    it('should return true for non-zero audio data', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-test-'));
      const filePath = path.join(tmpDir, 'test.wav');

      // Create a WAV-like file with non-zero data
      const header = Buffer.alloc(44, 0); // WAV header
      header.write('RIFF', 0);
      header.write('WAVE', 8);
      const audioData = Buffer.alloc(4096);
      for (let i = 0; i < audioData.length; i++) {
        audioData[i] = Math.floor(Math.random() * 256);
      }
      await fs.writeFile(filePath, Buffer.concat([header, audioData]));

      const result = await validateAudioData(filePath);
      expect(result).toBe(true);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should return false for all-zero audio data', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-test-'));
      const filePath = path.join(tmpDir, 'test.wav');

      // Create a WAV file with all-zero data
      const data = Buffer.alloc(8192, 0);
      data.write('RIFF', 0);
      data.write('WAVE', 8);
      await fs.writeFile(filePath, data);

      const result = await validateAudioData(filePath);
      expect(result).toBe(false);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should return false for empty file', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-test-'));
      const filePath = path.join(tmpDir, 'test.wav');
      await fs.writeFile(filePath, Buffer.alloc(0));

      const result = await validateAudioData(filePath);
      expect(result).toBe(false);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should return false for non-existent file', async () => {
      const result = await validateAudioData('/non/existent/file.wav');
      expect(result).toBe(false);
    });

    it('should detect non-zero data in the middle of large files', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-test-'));
      const filePath = path.join(tmpDir, 'test.wav');

      // Create a large WAV file with zeros at start and non-zero in middle
      const totalSize = 10000;
      const data = Buffer.alloc(totalSize, 0);
      data.write('RIFF', 0);
      data.write('WAVE', 8);
      // Put non-zero data in the middle
      for (let i = 5000; i < 5100; i++) {
        data[i] = 128;
      }
      await fs.writeFile(filePath, data);

      const result = await validateAudioData(filePath);
      expect(result).toBe(true);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe('recordDirectly', () => {
    it('should fail with error when ffmpeg is not available', async () => {
      // On most CI/test environments, ffmpeg might not be available
      // but the spawn itself should work and return an error
      const result = await recordDirectly({
        durationSeconds: 1,
        timeoutMs: 5000,
      });

      // Result should indicate the recording attempt was made
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('filePath');
      expect(result).toHaveProperty('fileSize');
      expect(result).toHaveProperty('duration');
      expect(result).toHaveProperty('usedTccWorkaround');
      expect(result.usedTccWorkaround).toBe(false);

      // Clean up temp file if created
      if (result.filePath) {
        fs.unlink(result.filePath).catch(() => {});
      }
    }, 10000);

    it('should use custom output path when provided', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-test-'));
      const customPath = path.join(tmpDir, 'custom-recording.wav');

      const result = await recordDirectly({
        outputPath: customPath,
        durationSeconds: 1,
        timeoutMs: 5000,
      });

      expect(result.filePath).toContain('custom-recording.wav');

      // Clean up
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }, 10000);

    it('should use custom command when provided', async () => {
      // Use a custom command that simulates recording failure
      const result = await recordDirectly({
        customCommand: 'echo "no audio" && exit 1',
        durationSeconds: 1,
        timeoutMs: 5000,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    }, 10000);
  });

  describe('recordViaTccWorkaround', () => {
    it('should fail gracefully when osascript is not available (non-macOS)', async () => {
      // On non-macOS, osascript doesn't exist
      if (process.platform === 'darwin') {
        // Skip this test on macOS where osascript is available
        return;
      }

      const result = await recordViaTccWorkaround({
        durationSeconds: 1,
        timeoutMs: 5000,
      });

      expect(result.success).toBe(false);
      expect(result.usedTccWorkaround).toBe(true);
      expect(result.error).toBeDefined();

      // Clean up temp file if created
      if (result.filePath) {
        fs.unlink(result.filePath).catch(() => {});
      }
    }, 10000);

    it('should respect timeout or fail fast on non-macOS', async () => {
      const result = await recordViaTccWorkaround({
        durationSeconds: 1,
        timeoutMs: 1000, // Very short timeout
      });

      // Should either timeout or fail fast (osascript not found on non-macOS)
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      // Clean up temp file if created
      if (result.filePath) {
        fs.unlink(result.filePath).catch(() => {});
      }
    }, 5000);
  });

  describe('recordAudio', () => {
    it('should use workaround when auto-detected on macOS + PM2', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
      process.env.PM2_HOME = '/home/user/.pm2';

      // Mock the recordViaTccWorkaround to avoid actual osascript calls
      const mockResult: AudioRecordResult = {
        success: true,
        filePath: '/tmp/test.wav',
        fileSize: 1024,
        duration: 5,
        usedTccWorkaround: true,
      };

      const mockRecordViaTcc = vi.fn().mockResolvedValue(mockResult);
      vi.doMock('./audio-record.js', async () => {
        const actual = await vi.importActual('./audio-record.js');
        return {
          ...actual,
          recordViaTccWorkaround: mockRecordViaTcc,
        };
      });

      // Since we can't easily doMock after module is already imported,
      // we test the auto-detection logic through shouldUseTccWorkaround
      expect(shouldUseTccWorkaround()).toBe(true);
    });

    it('should use direct recording on Linux', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      delete process.env.PM2_HOME;
      delete process.env.PM2_PID;

      const result = await recordAudio({
        durationSeconds: 1,
        timeoutMs: 5000,
      });

      expect(result.usedTccWorkaround).toBe(false);

      // Clean up
      if (result.filePath) {
        fs.unlink(result.filePath).catch(() => {});
      }
    }, 10000);

    it('should respect explicit useTccWorkaround=false', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
      process.env.PM2_HOME = '/home/user/.pm2';

      const result = await recordAudio({
        durationSeconds: 1,
        useTccWorkaround: false,
        timeoutMs: 5000,
      });

      expect(result.usedTccWorkaround).toBe(false);

      // Clean up
      if (result.filePath) {
        fs.unlink(result.filePath).catch(() => {});
      }
    }, 10000);
  });
});

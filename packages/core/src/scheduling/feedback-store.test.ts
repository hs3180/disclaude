import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  appendFeedback,
  readFeedback,
  clearFeedback,
  feedbackFilePath,
} from './feedback-store.js';

describe('FeedbackStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('feedbackFilePath', () => {
    it('returns correct path', () => {
      const result = feedbackFilePath('/workspace', 'discussion-abc');
      expect(result).toBe('/workspace/feedback/discussion-abc.md');
    });
  });

  describe('appendFeedback + readFeedback', () => {
    it('creates feedback file with single entry', async () => {
      await appendFeedback(tmpDir, 'discussion-abc', 'oc_source', 'Need more detail on section 2', 'oc_source');

      const entries = await readFeedback(tmpDir, 'discussion-abc');
      expect(entries).not.toBeNull();
      expect(entries!.length).toBe(1);
      expect(entries![0].text).toBe('Need more detail on section 2');
    });

    it('appends multiple entries in order', async () => {
      await appendFeedback(tmpDir, 'discussion-abc', 'oc_source', 'First feedback', 'oc_source');
      await appendFeedback(tmpDir, 'discussion-abc', 'oc_source', 'Second feedback', 'oc_source');
      await appendFeedback(tmpDir, 'discussion-abc', 'oc_source', 'Third feedback', 'oc_source');

      const entries = await readFeedback(tmpDir, 'discussion-abc');
      expect(entries).not.toBeNull();
      expect(entries!.length).toBe(3);
      expect(entries![0].text).toBe('First feedback');
      expect(entries![1].text).toBe('Second feedback');
      expect(entries![2].text).toBe('Third feedback');
    });

    it('reads null for non-existent file', async () => {
      const entries = await readFeedback(tmpDir, 'discussion-nonexistent');
      expect(entries).toBeNull();
    });

    it('entries have timestamps', async () => {
      await appendFeedback(tmpDir, 'discussion-abc', 'oc_source', 'Some feedback', 'oc_source');

      const entries = await readFeedback(tmpDir, 'discussion-abc');
      expect(entries).not.toBeNull();
      expect(entries![0].timestamp).toBeTruthy();
      // Should be parseable ISO date
      expect(() => new Date(entries![0].timestamp)).not.toThrow();
    });
  });

  describe('clearFeedback', () => {
    it('deletes existing feedback file', async () => {
      await appendFeedback(tmpDir, 'discussion-abc', 'oc_source', 'To be cleared', 'oc_source');
      const before = await readFeedback(tmpDir, 'discussion-abc');
      expect(before).not.toBeNull();

      await clearFeedback(tmpDir, 'discussion-abc');
      const after = await readFeedback(tmpDir, 'discussion-abc');
      expect(after).toBeNull();
    });

    it('does not throw for non-existent file', async () => {
      await expect(clearFeedback(tmpDir, 'discussion-nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('multiple mapping keys', () => {
    it('isolates feedback between different mappings', async () => {
      await appendFeedback(tmpDir, 'discussion-aaa', 'oc_source', 'Feedback A', 'oc_source');
      await appendFeedback(tmpDir, 'discussion-bbb', 'oc_source', 'Feedback B', 'oc_source');

      const entriesA = await readFeedback(tmpDir, 'discussion-aaa');
      const entriesB = await readFeedback(tmpDir, 'discussion-bbb');

      expect(entriesA!.length).toBe(1);
      expect(entriesA![0].text).toBe('Feedback A');
      expect(entriesB!.length).toBe(1);
      expect(entriesB![0].text).toBe('Feedback B');
    });
  });
});

/**
 * Unit tests for pr-scanner/label.ts GitHub label management.
 */

import { describe, it, expect } from 'vitest';
import {
  addLabel,
  removeLabel,
  REVIEWING_LABEL,
  getRepo,
} from '../label.js';

describe('label.ts', () => {
  describe('constants', () => {
    it('should export the reviewing label', () => {
      expect(REVIEWING_LABEL).toBe('pr-scanner:reviewing');
    });
  });

  describe('getRepo', () => {
    it('should return default repo when env not set', () => {
      const original = process.env.PR_SCANNER_REPO;
      delete process.env.PR_SCANNER_REPO;
      expect(getRepo()).toBe('hs3180/disclaude');
      process.env.PR_SCANNER_REPO = original;
    });

    it('should respect PR_SCANNER_REPO env', () => {
      const original = process.env.PR_SCANNER_REPO;
      process.env.PR_SCANNER_REPO = 'owner/repo';
      expect(getRepo()).toBe('owner/repo');
      process.env.PR_SCANNER_REPO = original;
    });
  });

  describe('addLabel', () => {
    it('should skip when PR_SCANNER_SKIP_LABELS is true', async () => {
      const original = process.env.PR_SCANNER_SKIP_LABELS;
      process.env.PR_SCANNER_SKIP_LABELS = 'true';
      // Should not throw
      await addLabel(123, 'test-label');
      process.env.PR_SCANNER_SKIP_LABELS = original;
    });
  });

  describe('removeLabel', () => {
    it('should skip when PR_SCANNER_SKIP_LABELS is true', async () => {
      const original = process.env.PR_SCANNER_SKIP_LABELS;
      process.env.PR_SCANNER_SKIP_LABELS = 'true';
      // Should not throw
      await removeLabel(123, 'test-label');
      process.env.PR_SCANNER_SKIP_LABELS = original;
    });
  });
});

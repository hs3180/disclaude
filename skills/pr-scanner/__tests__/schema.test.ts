/**
 * Unit tests for pr-scanner/schema.ts validation functions.
 */

import { describe, it, expect } from 'vitest';
import {
  validatePrNumber,
  validateState,
  validateTransition,
  validateDatetime,
  parsePrStateFile,
  validatePrStateFileData,
  parsePrNumberFromFilename,
  ValidationError,
  type PrState,
} from '../schema.js';

describe('schema validation', () => {
  describe('validatePrNumber', () => {
    it('should accept valid PR numbers', () => {
      expect(validatePrNumber(1)).toBe(1);
      expect(validatePrNumber(12345)).toBe(12345);
      expect(validatePrNumber('42')).toBe(42);
    });

    it('should reject non-positive numbers', () => {
      expect(() => validatePrNumber(0)).toThrow(ValidationError);
      expect(() => validatePrNumber(-1)).toThrow(ValidationError);
    });

    it('should reject non-integer numbers', () => {
      expect(() => validatePrNumber(1.5)).toThrow(ValidationError);
    });

    it('should reject non-numeric values', () => {
      expect(() => validatePrNumber('abc')).toThrow(ValidationError);
      expect(() => validatePrNumber(null)).toThrow(ValidationError);
      expect(() => validatePrNumber(undefined)).toThrow(ValidationError);
    });
  });

  describe('validateState', () => {
    it('should accept valid states', () => {
      expect(validateState('reviewing')).toBe('reviewing');
      expect(validateState('approved')).toBe('approved');
      expect(validateState('closed')).toBe('closed');
    });

    it('should reject invalid states', () => {
      expect(() => validateState('pending')).toThrow(ValidationError);
      expect(() => validateState('rejected')).toThrow(ValidationError);
      expect(() => validateState('')).toThrow(ValidationError);
    });
  });

  describe('validateTransition', () => {
    it('should allow valid transitions', () => {
      expect(() => validateTransition('reviewing', 'approved')).not.toThrow();
      expect(() => validateTransition('reviewing', 'closed')).not.toThrow();
      expect(() => validateTransition('approved', 'closed')).not.toThrow();
    });

    it('should reject invalid transitions', () => {
      expect(() => validateTransition('approved', 'reviewing')).toThrow(ValidationError);
      expect(() => validateTransition('closed', 'reviewing')).toThrow(ValidationError);
      expect(() => validateTransition('closed', 'approved')).toThrow(ValidationError);
    });
  });

  describe('validateDatetime', () => {
    it('should accept valid UTC datetime strings', () => {
      expect(validateDatetime('2026-04-15T10:00:00Z', 'test')).toBe('2026-04-15T10:00:00Z');
    });

    it('should reject non-UTC format', () => {
      expect(() => validateDatetime('2026-04-15T10:00:00+08:00', 'test')).toThrow(ValidationError);
    });

    it('should reject non-string values', () => {
      expect(() => validateDatetime(12345, 'test')).toThrow(ValidationError);
      expect(() => validateDatetime(null, 'test')).toThrow(ValidationError);
    });
  });

  describe('parsePrStateFile', () => {
    it('should parse valid state file JSON', () => {
      const json = JSON.stringify({
        prNumber: 42,
        chatId: null,
        state: 'reviewing',
        createdAt: '2026-04-15T10:00:00Z',
        updatedAt: '2026-04-15T10:00:00Z',
        expiresAt: '2026-04-17T10:00:00Z',
        disbandRequested: null,
      });
      const result = parsePrStateFile(json, 'test.json');
      expect(result.prNumber).toBe(42);
      expect(result.state).toBe('reviewing');
    });

    it('should reject invalid JSON', () => {
      expect(() => parsePrStateFile('not json', 'test.json')).toThrow(ValidationError);
    });

    it('should reject missing required fields', () => {
      const json = JSON.stringify({ prNumber: 42 });
      expect(() => parsePrStateFile(json, 'test.json')).toThrow(ValidationError);
    });
  });

  describe('validatePrStateFileData', () => {
    it('should validate all required fields', () => {
      const data = {
        prNumber: 42,
        chatId: 'oc_123',
        state: 'reviewing',
        createdAt: '2026-04-15T10:00:00Z',
        updatedAt: '2026-04-15T10:00:00Z',
        expiresAt: '2026-04-17T10:00:00Z',
        disbandRequested: null,
      };
      const result = validatePrStateFileData(data, 'test.json');
      expect(result.chatId).toBe('oc_123');
    });

    it('should reject invalid prNumber', () => {
      const data = {
        prNumber: 'not-a-number',
        state: 'reviewing',
        createdAt: '2026-04-15T10:00:00Z',
        updatedAt: '2026-04-15T10:00:00Z',
        expiresAt: '2026-04-17T10:00:00Z',
        disbandRequested: null,
      };
      expect(() => validatePrStateFileData(data, 'test.json')).toThrow(ValidationError);
    });

    it('should reject invalid state', () => {
      const data = {
        prNumber: 42,
        state: 'unknown',
        createdAt: '2026-04-15T10:00:00Z',
        updatedAt: '2026-04-15T10:00:00Z',
        expiresAt: '2026-04-17T10:00:00Z',
        disbandRequested: null,
      };
      expect(() => validatePrStateFileData(data, 'test.json')).toThrow(ValidationError);
    });

    it('should reject non-null disbandRequested', () => {
      const data = {
        prNumber: 42,
        chatId: null,
        state: 'reviewing',
        createdAt: '2026-04-15T10:00:00Z',
        updatedAt: '2026-04-15T10:00:00Z',
        expiresAt: '2026-04-17T10:00:00Z',
        disbandRequested: 'some value',
      };
      expect(() => validatePrStateFileData(data, 'test.json')).toThrow(ValidationError);
    });

    it('should reject non-object data', () => {
      expect(() => validatePrStateFileData(null, 'test.json')).toThrow(ValidationError);
      expect(() => validatePrStateFileData('string', 'test.json')).toThrow(ValidationError);
      expect(() => validatePrStateFileData([], 'test.json')).toThrow(ValidationError);
    });
  });

  describe('parsePrNumberFromFilename', () => {
    it('should extract PR number from valid filename', () => {
      expect(parsePrNumberFromFilename('pr-123.json')).toBe(123);
      expect(parsePrNumberFromFilename('pr-1.json')).toBe(1);
    });

    it('should return null for non-matching filenames', () => {
      expect(parsePrNumberFromFilename('other.json')).toBeNull();
      expect(parsePrNumberFromFilename('pr-abc.json')).toBeNull();
    });
  });
});

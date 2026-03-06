import { describe, it, expect } from 'vitest';
import { createNextStepAssessor, from './next-step-assessor.js';

describe('NextStepAssessor', () => {
  it('should parse valid JSON response', () => {
    const assessor = createNextStepAssessor();
    const response = `{
      "taskType": "bug_fix",
      "summary": "Fixed a bug",
      "candidates": [
        { "id": "test1", "title": "📋 Test", "description": "A test action", "action": "test_action" }
      ]
    }`;

    const result = assessor['parseResponse'](JSON.stringify(response));
    expect(result).toEqual(response);
  });

  it('should handle missing fields with defaults', () => {
    const assessor = createNextStepAssessor();
    const response = `{
      "taskType": "general"
      "candidates": []
    }`;

    const result = assessor['parseResponse'](JSON.stringify(response));
    expect(result?.taskType).toBe('general');
    expect(result?.candidates).toHaveLength(1);
    expect(result?.candidates[0].id).toBe('continue');
  });

  it('should return default assessment when no JSON found', () => {
    const assessor = createNextStepAssessor();
    const result = assessor['parseResponse']('No JSON here, just some text');
    expect(result?.taskType).toBe('general');
    expect(result?.candidates[0].id).toBe('continue');
  });

  it('should return default assessment on invalid JSON', () => {
    const assessor = createNextStepAssessor();
    const result = assessor['parseResponse']('{"invalid": true}');
    expect(result?.taskType).toBe('general');
  });
});

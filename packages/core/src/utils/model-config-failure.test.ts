import { describe, expect, it } from 'vitest';
import { isModelSwitchFailure } from './model-config-failure.js';

describe('isModelSwitchFailure (Issue #4914 contextual config hint)', () => {
  it('matches upstream texts that name the model as the problem', () => {
    expect(
      isModelSwitchFailure(
        'Error code: 404 - The model `gpt-5.6-luna` does not exist or you do not have access to it.'
      )
    ).toBe(true);
    expect(
      isModelSwitchFailure('Selected model is at capacity. Please try a different model.')
    ).toBe(true);
    expect(
      isModelSwitchFailure('not_found_error: model: claude-sonnet-4-5 could not be found')
    ).toBe(true);
    expect(isModelSwitchFailure('Error code: model_not_found - Invalid model name')).toBe(true);
    expect(
      isModelSwitchFailure('Error code: model_access_expired - Please use another model')
    ).toBe(true);
    expect(isModelSwitchFailure('You do not have access to the model glm-4.7')).toBe(true);
    expect(isModelSwitchFailure('Error message: 模型不存在，请检查模型名称')).toBe(true);
    expect(isModelSwitchFailure('该请求失败：模型已下线')).toBe(true);
  });

  it('does not match credentials, network, transient-capacity or task-shape failures', () => {
    expect(isModelSwitchFailure('Error code: 401 - invalid x-api-key')).toBe(false);
    expect(isModelSwitchFailure('authentication_error: invalid api key')).toBe(false);
    expect(isModelSwitchFailure('workspace routing discovery failed: connect ETIMEDOUT')).toBe(
      false
    );
    expect(isModelSwitchFailure('upstream request failed: overloaded_error (529)')).toBe(false);
    expect(isModelSwitchFailure('Internal server error (500), please retry')).toBe(false);
    expect(isModelSwitchFailure('DSH CONTEXT_WINDOW_EXCEEDED')).toBe(false);
    expect(isModelSwitchFailure('model response stream ended unexpectedly')).toBe(false);
    expect(isModelSwitchFailure('A task failed after retries; the tool output was too large')).toBe(
      false
    );
  });
});

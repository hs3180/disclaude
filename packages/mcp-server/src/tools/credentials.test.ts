/**
 * Tests for credentials utility (packages/mcp-server/src/tools/credentials.ts)
 */

import { describe, it, expect, vi } from 'vitest';

// vi.mock is hoisted - all variables must be inlined in the factory
vi.mock('@disclaude/core', () => ({
  Config: {
    FEISHU_APP_ID: '',
    FEISHU_APP_SECRET: '',
    getWorkspaceDir: vi.fn(() => '/default/workspace'),
  },
}));

import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';
import { Config } from '@disclaude/core';

describe('getFeishuCredentials', () => {
  it('should return undefined values when credentials are not configured', () => {
    const result = getFeishuCredentials();
    expect(result.appId).toBeUndefined();
    expect(result.appSecret).toBeUndefined();
  });

  it('should return configured appId and appSecret', () => {
    vi.spyOn(Config, 'FEISHU_APP_ID', 'get').mockReturnValue('test_app_id');
    vi.spyOn(Config, 'FEISHU_APP_SECRET', 'get').mockReturnValue('test_app_secret');

    const result = getFeishuCredentials();
    expect(result.appId).toBe('test_app_id');
    expect(result.appSecret).toBe('test_app_secret');

    vi.restoreAllMocks();
  });

  it('should return undefined for appId when empty string', () => {
    vi.spyOn(Config, 'FEISHU_APP_ID', 'get').mockReturnValue('');
    vi.spyOn(Config, 'FEISHU_APP_SECRET', 'get').mockReturnValue('secret_only');

    const result = getFeishuCredentials();
    expect(result.appId).toBeUndefined();
    expect(result.appSecret).toBe('secret_only');

    vi.restoreAllMocks();
  });

  it('should return undefined for appSecret when empty string', () => {
    vi.spyOn(Config, 'FEISHU_APP_ID', 'get').mockReturnValue('id_only');
    vi.spyOn(Config, 'FEISHU_APP_SECRET', 'get').mockReturnValue('');

    const result = getFeishuCredentials();
    expect(result.appId).toBe('id_only');
    expect(result.appSecret).toBeUndefined();

    vi.restoreAllMocks();
  });
});

describe('getWorkspaceDir', () => {
  it('should return workspace directory from Config', () => {
    vi.mocked(Config.getWorkspaceDir).mockReturnValue('/custom/workspace');
    expect(getWorkspaceDir()).toBe('/custom/workspace');
    vi.mocked(Config.getWorkspaceDir).mockReturnValue('/default/workspace');
  });

  it('should return default workspace directory', () => {
    vi.mocked(Config.getWorkspaceDir).mockReturnValue('/default/workspace');
    expect(getWorkspaceDir()).toBe('/default/workspace');
  });
});

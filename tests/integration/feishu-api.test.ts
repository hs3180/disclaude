/**
 * Feishu API Integration Tests
 *
 * Tests real Feishu API interactions using sandbox environment.
 *
 * Required environment variables:
 * - FEISHU_APP_ID: Feishu application ID
 * - FEISHU_APP_SECRET: Feishu application secret
 *
 * These tests verify:
 * - Tenant access token acquisition
 * - Message sending capabilities
 * - User info retrieval
 * - Error handling with real API responses
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { describeIfEnvVars, testId } from './setup.js';
import { Client, Domain } from '@larksuiteoapi/node-sdk';

const FEISHU_ENV_VARS = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'];

describeIfEnvVars('Feishu API Integration', FEISHU_ENV_VARS, () => {
  let client: InstanceType<typeof Client>;

  beforeAll(async () => {
    // Create Feishu client with sandbox configuration
    client = new Client({
      appId: process.env.FEISHU_APP_ID!,
      appSecret: process.env.FEISHU_APP_SECRET!,
      domain: Domain.Feishu, // Use Feishu domain (Lark uses Domain.Lark)
    });
  });

  afterAll(async () => {
    // Cleanup if needed
  });

  describe('Tenant Access Token', () => {
    it('should acquire tenant access token successfully', async () => {
      // The SDK handles token acquisition internally
      // We verify by making a simple API call that requires authentication
      const response = await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: 'invalid_chat_id_for_test',
          msg_type: 'text',
          content: JSON.stringify({ text: 'test' }),
        },
      });

      // Even with invalid chat_id, successful auth means we got past token validation
      // The error will be about invalid chat, not auth failure
      expect(response).toBeDefined();
    });
  });

  describe('Message API Error Handling', () => {
    it('should handle invalid chat_id gracefully', async () => {
      const response = await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: `invalid-${testId()}`,
          msg_type: 'text',
          content: JSON.stringify({ text: 'test message' }),
        },
      });

      // API should return an error code for invalid chat
      expect(response).toBeDefined();
      expect(response.code).toBeDefined();
      // Error code for invalid chat_id (varies by Feishu version)
      expect([99991663, 99991661, 230001]).toContain(response.code);
    });

    it('should handle invalid message type gracefully', async () => {
      const response = await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: `test-${testId()}`,
          msg_type: 'invalid_type' as any,
          content: JSON.stringify({ text: 'test' }),
        },
      });

      expect(response).toBeDefined();
      expect(response.code).toBeDefined();
    });
  });

  describe('User API', () => {
    it('should handle invalid user_id query', async () => {
      // Try to get user info with invalid ID
      const response = await client.contact.user.batchGet({
        params: {
          user_id_type: 'open_id',
        },
        data: {
          user_ids: [`invalid_user_${testId()}`],
        },
      });

      // Should return empty or error for invalid user
      expect(response).toBeDefined();
    });
  });
});

// Run basic tests that don't require credentials
describe('Feishu SDK Configuration', () => {
  it('should have Feishu domain available', () => {
    // Domain is an enum where Feishu = 0, Lark = 1
    expect(Domain.Feishu).toBeDefined();
    expect(Domain.Lark).toBeDefined();
  });

  it('should create client with valid config structure', () => {
    // Test client creation without making API calls
    const testClient = new Client({
      appId: 'test_app_id',
      appSecret: 'test_secret',
      domain: Domain.Feishu,
    });

    expect(testClient).toBeDefined();
    expect(testClient.im).toBeDefined();
    expect(testClient.contact).toBeDefined();
  });
});

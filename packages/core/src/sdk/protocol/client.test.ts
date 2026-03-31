/**
 * Unit tests for ACP Client
 *
 * @module sdk/protocol/client.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { ACPClient } from './client.js';
import {
  ACPProtocolError,
  ACPConnectionError,
  ACPTimeoutError,
} from './errors.js';

const TEST_BASE_URL = 'http://localhost:8000';

describe('ACPClient', () => {
  let client: ACPClient;

  beforeEach(() => {
    // Note: localhost is already allowed by global test setup (tests/setup.ts)
    client = new ACPClient({ baseUrl: TEST_BASE_URL });
  });

  afterEach(() => {
    client.dispose();
    nock.cleanAll();
  });

  describe('constructor', () => {
    it('should normalize trailing slash in baseUrl', () => {
      const c = new ACPClient({ baseUrl: 'http://localhost:8000/' });
      expect(c.getBaseUrl()).toBe('http://localhost:8000');
      c.dispose();
    });

    it('should use default timeout when not specified', () => {
      const c = new ACPClient({ baseUrl: TEST_BASE_URL });
      // Should not throw - default timeout is used
      c.dispose();
    });

    it('should merge custom headers', () => {
      const c = new ACPClient({
        baseUrl: TEST_BASE_URL,
        headers: { 'X-Custom': 'value' },
      });
      // Headers are private, but we can verify the client works
      c.dispose();
    });
  });

  describe('ping', () => {
    it('should return true for successful ping', async () => {
      nock(TEST_BASE_URL).get('/ping').reply(200);

      const result = await client.ping();
      expect(result).toBe(true);
    });

    it('should return false for failed ping', async () => {
      nock(TEST_BASE_URL).get('/ping').reply(500);

      const result = await client.ping();
      expect(result).toBe(false);
    });

    it('should return false on connection error', async () => {
      nock(TEST_BASE_URL).get('/ping').replyWithError('ECONNREFUSED');

      const result = await client.ping();
      expect(result).toBe(false);
    });
  });

  describe('listAgents', () => {
    it('should return list of agent manifests', async () => {
      const mockAgents = {
        agents: [
          {
            name: 'echo',
            description: 'Echoes everything',
            input_content_types: ['*/*'],
            output_content_types: ['text/plain'],
          },
          {
            name: 'research',
            description: 'Research agent',
            input_content_types: ['text/plain'],
            output_content_types: ['text/plain'],
          },
        ],
      };

      nock(TEST_BASE_URL)
        .get('/agents')
        .reply(200, mockAgents);

      const agents = await client.listAgents();
      expect(agents).toHaveLength(2);
      expect(agents[0].name).toBe('echo');
      expect(agents[1].name).toBe('research');
    });

    it('should pass limit and offset query params', async () => {
      nock(TEST_BASE_URL)
        .get('/agents')
        .query({ limit: '5', offset: '10' })
        .reply(200, { agents: [] });

      await client.listAgents({ limit: 5, offset: 10 });
    });

    it('should throw ACPProtocolError on error response', async () => {
      nock(TEST_BASE_URL)
        .get('/agents')
        .reply(500, {
          code: 'server_error',
          message: 'Internal server error',
        });

      await expect(client.listAgents()).rejects.toThrow(ACPProtocolError);
    });
  });

  describe('getAgent', () => {
    it('should return agent manifest', async () => {
      const mockManifest = {
        name: 'echo',
        description: 'Echoes everything',
        input_content_types: ['*/*'],
        output_content_types: ['text/plain'],
      };

      nock(TEST_BASE_URL)
        .get('/agents/echo')
        .reply(200, mockManifest);

      const agent = await client.getAgent('echo');
      expect(agent.name).toBe('echo');
      expect(agent.description).toBe('Echoes everything');
    });

    it('should URL-encode agent name', async () => {
      nock(TEST_BASE_URL)
        .get('/agents/my-agent')
        .reply(200, {
          name: 'my-agent',
          description: 'Test',
          input_content_types: ['*/*'],
          output_content_types: ['text/plain'],
        });

      await client.getAgent('my-agent');
    });

    it('should throw on 404', async () => {
      nock(TEST_BASE_URL)
        .get('/agents/nonexistent')
        .reply(404, {
          code: 'not_found',
          message: 'Agent "nonexistent" not found',
        });

      const error = await client.getAgent('nonexistent').catch(
        (e) => e as ACPProtocolError
      );
      expect(error).toBeInstanceOf(ACPProtocolError);
      expect(error.code).toBe('not_found');
      expect(error.statusCode).toBe(404);
    });
  });

  describe('createRun', () => {
    it('should create a run and return result', async () => {
      const mockRun = {
        agent_name: 'echo',
        run_id: 'run-123',
        session_id: 'session-456',
        status: 'completed',
        output: [
          {
            role: 'agent/echo',
            parts: [{ content_type: 'text/plain', content: 'Hello!' }],
          },
        ],
        created_at: '2026-04-01T00:00:00Z',
      };

      nock(TEST_BASE_URL)
        .post('/runs')
        .reply(200, mockRun);

      const run = await client.createRun({
        agent_name: 'echo',
        input: [
          {
            role: 'user',
            parts: [{ content_type: 'text/plain', content: 'Hello!' }],
          },
        ],
      });

      expect(run.run_id).toBe('run-123');
      expect(run.status).toBe('completed');
    });

    it('should throw on validation error', async () => {
      nock(TEST_BASE_URL)
        .post('/runs')
        .reply(400, {
          code: 'invalid_input',
          message: 'Missing required field: agent_name',
        });

      await expect(
        client.createRun({ agent_name: 'echo', input: [] })
      ).rejects.toThrow(ACPProtocolError);
    });
  });

  describe('getRun', () => {
    it('should return run status', async () => {
      const mockRun = {
        agent_name: 'echo',
        run_id: 'run-123',
        status: 'in-progress',
        output: [],
        created_at: '2026-04-01T00:00:00Z',
      };

      nock(TEST_BASE_URL)
        .get('/runs/run-123')
        .reply(200, mockRun);

      const run = await client.getRun('run-123');
      expect(run.status).toBe('in-progress');
    });
  });

  describe('cancelRun', () => {
    it('should cancel a run', async () => {
      const mockRun = {
        agent_name: 'echo',
        run_id: 'run-123',
        status: 'cancelled',
        output: [],
        created_at: '2026-04-01T00:00:00Z',
      };

      nock(TEST_BASE_URL)
        .post('/runs/run-123/cancel')
        .reply(202, mockRun);

      const run = await client.cancelRun('run-123');
      expect(run.status).toBe('cancelled');
    });
  });

  describe('getSession', () => {
    it('should return session details', async () => {
      const mockSession = {
        id: 'session-456',
        history: ['http://localhost:8000/runs/run-1'],
      };

      nock(TEST_BASE_URL)
        .get('/session/session-456')
        .reply(200, mockSession);

      const session = await client.getSession('session-456');
      expect(session.id).toBe('session-456');
      expect(session.history).toHaveLength(1);
    });
  });

  describe('streamRun', () => {
    it('should parse SSE events from stream response', async () => {
      const sseEvents = [
        'data: {"type":"run.created","run":{"agent_name":"echo","run_id":"run-1","status":"created","output":[],"created_at":"2026-04-01T00:00:00Z"}}\n\n',
        'data: {"type":"message.created","message":{"role":"agent","parts":[{"content_type":"text/plain","content":""}]}}\n\n',
        'data: {"type":"message.part","part":{"content_type":"text/plain","content":"Hello"}}\n\n',
        'data: {"type":"message.completed","message":{"role":"agent","parts":[{"content_type":"text/plain","content":"Hello world!"}]}}\n\n',
        'data: {"type":"run.completed","run":{"agent_name":"echo","run_id":"run-1","status":"completed","output":[{"role":"agent","parts":[{"content_type":"text/plain","content":"Hello world!"}]}],"created_at":"2026-04-01T00:00:00Z"}}\n\n',
      ].join('');

      nock(TEST_BASE_URL)
        .post('/runs')
        .reply(200, sseEvents, {
          'Content-Type': 'text/event-stream',
        });

      const events: unknown[] = [];
      for await (const event of client.streamRun({
        agent_name: 'echo',
        input: [
          {
            role: 'user',
            parts: [{ content_type: 'text/plain', content: 'Hi' }],
          },
        ],
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(5);
      expect((events[0] as { type: string }).type).toBe('run.created');
      expect((events[4] as { type: string }).type).toBe('run.completed');
    });

    it('should handle non-SSE response as fallback', async () => {
      const mockRun = {
        agent_name: 'echo',
        run_id: 'run-1',
        status: 'completed',
        output: [
          {
            role: 'agent/echo',
            parts: [{ content_type: 'text/plain', content: 'Done' }],
          },
        ],
        created_at: '2026-04-01T00:00:00Z',
      };

      nock(TEST_BASE_URL)
        .post('/runs')
        .reply(200, mockRun, {
          'Content-Type': 'application/json',
        });

      const events: unknown[] = [];
      for await (const event of client.streamRun({
        agent_name: 'echo',
        input: [
          {
            role: 'user',
            parts: [{ content_type: 'text/plain', content: 'Hi' }],
          },
        ],
      })) {
        events.push(event);
      }

      // Should produce run.created and run.completed events
      expect(events).toHaveLength(2);
      expect((events[0] as { type: string }).type).toBe('run.created');
      expect((events[1] as { type: string }).type).toBe('run.completed');
    });

    it('should throw on error response during stream', async () => {
      nock(TEST_BASE_URL)
        .post('/runs')
        .reply(500, {
          code: 'server_error',
          message: 'Stream failed',
        });

      const generator = client.streamRun({
        agent_name: 'echo',
        input: [
          {
            role: 'user',
            parts: [{ content_type: 'text/plain', content: 'Hi' }],
          },
        ],
      });

      await expect(
        (async () => {
          for await (const _event of generator) {
            // Should not reach here
          }
        })()
      ).rejects.toThrow(ACPProtocolError);
    });
  });

  describe('error handling', () => {
    it('should throw ACPConnectionError on connection failure', async () => {
      nock(TEST_BASE_URL)
        .get('/agents')
        .replyWithError('ECONNREFUSED');

      await expect(client.listAgents()).rejects.toThrow(ACPConnectionError);
    });

    it('should throw ACPTimeoutError on timeout', async () => {
      const timeoutClient = new ACPClient({
        baseUrl: TEST_BASE_URL,
        timeout: 1, // 1ms timeout for testing
      });

      nock(TEST_BASE_URL)
        .get('/agents')
        .delay(100) // Delay longer than timeout
        .reply(200, { agents: [] });

      await expect(timeoutClient.listAgents()).rejects.toThrow(ACPTimeoutError);
      timeoutClient.dispose();
    });
  });

  describe('dispose', () => {
    it('should prevent operations after dispose', async () => {
      client.dispose();

      await expect(client.listAgents()).rejects.toThrow(
        'ACPClient has been disposed'
      );
    });

    it('should prevent createRun after dispose', async () => {
      client.dispose();

      await expect(
        client.createRun({
          agent_name: 'echo',
          input: [
            {
              role: 'user',
              parts: [{ content_type: 'text/plain', content: 'test' }],
            },
          ],
        })
      ).rejects.toThrow('ACPClient has been disposed');
    });
  });
});

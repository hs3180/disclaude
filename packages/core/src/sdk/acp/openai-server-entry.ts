#!/usr/bin/env node
/**
 * OpenAI ACP Server — Standalone entry point.
 *
 * This file is the CLI entry point for running the OpenAI ACP Server
 * as a standalone process. It reads JSON-RPC from stdin and writes
 * JSON-RPC responses/notifications to stdout.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... npx tsx packages/core/src/sdk/acp/openai-server-entry.ts
 *   OPENAI_API_KEY=sk-... node dist/sdk/acp/openai-server-entry.js
 *
 * @see Issue #1333
 */

import { run } from './openai-server.js';

run();

#!/usr/bin/env tsx
/**
 * survey/create.ts — Create a new survey file.
 *
 * Creates a survey JSON file in workspace/surveys/ with the specified
 * questions, options, and metadata.
 *
 * Environment variables:
 *   SURVEY_ID          (required) Unique survey identifier (e.g. "restaurant-review")
 *   SURVEY_TITLE       (required) Survey title (max 100 chars)
 *   SURVEY_CHAT_ID     (required) Target Feishu chat ID (oc_xxx format)
 *   SURVEY_EXPIRES_AT  (required) ISO 8601 Z-suffix expiry timestamp
 *   SURVEY_QUESTIONS   (required) JSON array of question objects
 *   SURVEY_DESCRIPTION (optional) Survey description (max 500 chars)
 *   SURVEY_ANONYMOUS   (optional) 'true' for anonymous survey (default: 'false')
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 */

import { mkdir, writeFile, stat, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  validateTitle,
  validateDescription,
  validateChatId,
  validateExpiresAt,
  validateQuestions,
  nowISO,
  SURVEY_DIR,
  ValidationError,
  type SurveyFile,
} from './schema.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  // ---- Step 1: Validate survey ID ----
  const surveyId = process.env.SURVEY_ID ?? '';
  try {
    validateSurveyId(surveyId);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 2: Validate required fields ----
  const title = process.env.SURVEY_TITLE ?? '';
  try {
    validateTitle(title);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const chatId = process.env.SURVEY_CHAT_ID ?? '';
  try {
    validateChatId(chatId);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const expiresAt = process.env.SURVEY_EXPIRES_AT ?? '';
  try {
    validateExpiresAt(expiresAt);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 3: Validate questions ----
  const questionsRaw = process.env.SURVEY_QUESTIONS;
  let questions;
  try {
    const parsed = questionsRaw ? JSON.parse(questionsRaw) : undefined;
    questions = validateQuestions(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`SURVEY_QUESTIONS must be valid JSON: ${questionsRaw}`);
  }

  // ---- Step 4: Validate optional fields ----
  const description = process.env.SURVEY_DESCRIPTION ?? '';
  try {
    validateDescription(description);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const anonymousRaw = process.env.SURVEY_ANONYMOUS ?? 'false';
  const anonymous = anonymousRaw === 'true';

  // ---- Step 5: Setup directory and resolve path ----
  const surveyDir = resolve(SURVEY_DIR);
  await mkdir(surveyDir, { recursive: true });

  const surveyFile = resolve(surveyDir, `${surveyId}.json`);

  // Path traversal protection
  if (!surveyFile.startsWith(surveyDir + '/')) {
    exit(`Path traversal detected for survey ID '${surveyId}'`);
  }

  // ---- Step 6: Check uniqueness ----
  try {
    await stat(surveyFile);
    exit(`Survey ${surveyId} already exists`);
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code !== 'ENOENT') {
      throw new Error(`Failed to check survey file: ${err}`);
    }
  }

  // ---- Step 7: Write survey file ----
  const surveyData: SurveyFile = {
    id: surveyId,
    title,
    description,
    chatId,
    createdAt: nowISO(),
    expiresAt,
    anonymous,
    status: 'active',
    questions,
    responses: {},
  };

  // Atomic write: write to temp file then rename
  const tmpFile = `${surveyFile}.${Date.now()}.tmp`;
  await writeFile(tmpFile, JSON.stringify(surveyData, null, 2) + '\n', 'utf-8');
  await rename(tmpFile, surveyFile);

  console.log(`OK: Survey ${surveyId} created successfully with ${questions.length} question(s)`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

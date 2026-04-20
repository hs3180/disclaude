#!/usr/bin/env tsx
/**
 * survey/create.ts — Create a new survey/poll.
 *
 * Environment variables:
 *   SURVEY_ID            (required) Unique survey identifier
 *   SURVEY_TITLE         (required) Survey title (max 128 chars)
 *   SURVEY_DESCRIPTION   (optional) Survey description (max 1024 chars, default: '')
 *   SURVEY_EXPIRES_AT    (required) ISO 8601 Z-suffix expiry timestamp
 *   SURVEY_CREATOR       (required) Creator's open ID
 *   SURVEY_TARGET_USERS  (required) JSON array of target user open IDs
 *   SURVEY_QUESTIONS     (required) JSON array of question objects
 *   SURVEY_ANONYMOUS     (optional) 'true' or 'false' (default: 'false')
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
  validateExpiresAt,
  validateCreator,
  validateTargetUsers,
  validateQuestions,
  nowISO,
  SURVEY_DIR,
  ValidationError,
  type SurveyFile,
  type SurveyQuestion,
} from './schema.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  // ---- Step 1: Validate survey ID ----
  const surveyId = process.env.SURVEY_ID;
  try {
    validateSurveyId(surveyId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 2: Validate required fields ----
  const title = process.env.SURVEY_TITLE;
  try {
    validateTitle(title ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const description = process.env.SURVEY_DESCRIPTION ?? '';
  try {
    validateDescription(description);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const expiresAt = process.env.SURVEY_EXPIRES_AT;
  try {
    validateExpiresAt(expiresAt ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const creator = process.env.SURVEY_CREATOR;
  try {
    validateCreator(creator ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const targetUsersRaw = process.env.SURVEY_TARGET_USERS;
  let targetUsers: string[];
  try {
    const parsed = targetUsersRaw ? JSON.parse(targetUsersRaw) : undefined;
    targetUsers = validateTargetUsers(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`SURVEY_TARGET_USERS must be valid JSON: ${targetUsersRaw}`);
  }

  const questionsRaw = process.env.SURVEY_QUESTIONS;
  let questions: SurveyQuestion[];
  try {
    const parsed = questionsRaw ? JSON.parse(questionsRaw) : undefined;
    questions = validateQuestions(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`SURVEY_QUESTIONS must be valid JSON: ${questionsRaw}`);
  }

  // Validate anonymous flag
  const anonymousRaw = process.env.SURVEY_ANONYMOUS ?? 'false';
  let anonymous: boolean;
  if (anonymousRaw === 'true') {
    anonymous = true;
  } else if (anonymousRaw === 'false') {
    anonymous = false;
  } else {
    exit(`SURVEY_ANONYMOUS must be 'true' or 'false', got '${anonymousRaw}'`);
  }

  // ---- Step 3: Setup directory and resolve path ----
  const surveyDir = resolve(SURVEY_DIR);
  await mkdir(surveyDir, { recursive: true });

  const surveyFile = resolve(surveyDir, `${surveyId}.json`);

  // Path traversal protection
  if (!surveyFile.startsWith(surveyDir + '/')) {
    exit(`Path traversal detected for survey ID '${surveyId}'`);
  }

  // ---- Step 4: Check uniqueness ----
  try {
    await stat(surveyFile);
    throw new ValidationError(`Survey ${surveyId} already exists`);
  } catch (err: unknown) {
    if (err instanceof ValidationError) throw err;
    const nodeErr = err as { code?: string };
    if (nodeErr.code !== 'ENOENT') {
      throw new Error(`Failed to check survey file: ${err}`);
    }
  }

  // ---- Step 5: Write survey file ----
  const surveyData: SurveyFile = {
    id: surveyId!,
    title: title!,
    description,
    status: 'open',
    anonymous,
    createdAt: nowISO(),
    expiresAt: expiresAt!,
    closedAt: null,
    creator: creator!,
    targetUsers,
    questions,
    responses: {},
  };

  // Atomic write: write to temp file then rename
  const tmpFile = `${surveyFile}.${Date.now()}.tmp`;
  await writeFile(tmpFile, JSON.stringify(surveyData, null, 2) + '\n', 'utf-8');
  await rename(tmpFile, surveyFile);

  console.log(`OK: Survey ${surveyId} created successfully`);
  console.log(`Title: ${title}`);
  console.log(`Questions: ${questions.length}`);
  console.log(`Target users: ${targetUsers.length}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

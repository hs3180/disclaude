#!/usr/bin/env tsx
/**
 * survey/create.ts — Create a new survey file.
 *
 * Environment variables:
 *   SURVEY_ID           (required) Unique survey identifier
 *   SURVEY_TITLE        (required) Survey title
 *   SURVEY_DESCRIPTION  (optional) Survey description (default: '')
 *   SURVEY_QUESTIONS    (required) JSON array of question objects
 *   SURVEY_PARTICIPANTS (required) JSON array of participant open IDs
 *   SURVEY_ANONYMOUS    (optional) 'true' for anonymous survey (default: 'false')
 *   SURVEY_DEADLINE     (required) ISO 8601 Z-suffix deadline timestamp
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
  validateQuestions,
  validateParticipants,
  validateDeadline,
  nowISO,
  SURVEY_DIR,
  ValidationError,
  type SurveyFile,
} from './schema.js';
import { withExclusiveLock } from './lock.js';

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

  // ---- Step 2: Validate title ----
  const title = process.env.SURVEY_TITLE;
  try {
    validateTitle(title ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 3: Validate description ----
  const description = process.env.SURVEY_DESCRIPTION ?? '';
  try {
    validateDescription(description);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 4: Validate questions ----
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

  // ---- Step 5: Validate participants ----
  const participantsRaw = process.env.SURVEY_PARTICIPANTS;
  let participants: string[];
  try {
    const parsed = participantsRaw ? JSON.parse(participantsRaw) : undefined;
    participants = validateParticipants(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`SURVEY_PARTICIPANTS must be valid JSON: ${participantsRaw}`);
  }

  // ---- Step 6: Validate deadline ----
  const deadline = process.env.SURVEY_DEADLINE;
  try {
    validateDeadline(deadline ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 7: Validate anonymous flag ----
  const anonymousRaw = process.env.SURVEY_ANONYMOUS;
  const anonymous = anonymousRaw === 'true';

  // ---- Step 8: Setup directory and resolve path ----
  const surveyDir = resolve(SURVEY_DIR);
  await mkdir(surveyDir, { recursive: true });

  const surveyFile = resolve(surveyDir, `${surveyId}.json`);

  // Path traversal protection
  if (!surveyFile.startsWith(surveyDir + '/')) {
    exit(`Path traversal detected for survey ID '${surveyId}'`);
  }

  // ---- Step 9: Check uniqueness under lock ----
  const lockPath = `${surveyFile}.lock`;
  await withExclusiveLock(lockPath, async () => {
    // Double-check file doesn't exist
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

    // ---- Step 10: Write survey file ----
    const surveyData: SurveyFile = {
      id: surveyId!,
      status: 'open',
      title: title!,
      description,
      questions,
      participants,
      anonymous,
      createdAt: nowISO(),
      deadline: deadline!,
      closedAt: null,
      responses: [],
    };

    // Atomic write: write to temp file then rename
    const tmpFile = `${surveyFile}.${Date.now()}.tmp`;
    await writeFile(tmpFile, JSON.stringify(surveyData, null, 2) + '\n', 'utf-8');
    await rename(tmpFile, surveyFile);
  });

  console.log(`OK: Survey ${surveyId} created successfully`);
  console.log(`  Title: ${title}`);
  console.log(`  Questions: ${questions.length}`);
  console.log(`  Participants: ${participants.length}`);
  console.log(`  Deadline: ${deadline}`);
  console.log(`  Anonymous: ${anonymous}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

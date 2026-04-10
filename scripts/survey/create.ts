#!/usr/bin/env tsx
/**
 * survey/create.ts — Create a new survey definition file.
 *
 * Environment variables:
 *   SURVEY_TITLE     (required) Survey title
 *   SURVEY_QUESTIONS (required) JSON array of question objects
 *   SURVEY_DEADLINE  (required) ISO 8601 Z-suffix deadline
 *   SURVEY_ANONYMOUS (optional) "true" or "false" (default: "false")
 *   SURVEY_TARGETS   (required) JSON array of target user open IDs
 *   SURVEY_CREATOR   (required) Creator's open ID
 *   SURVEY_DESC      (optional) Survey description
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 */

import { mkdir, writeFile, stat, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateTitle,
  validateQuestions,
  validateDeadline,
  validateTargets,
  validateCreator,
  generateSurveyId,
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
  // ---- Step 1: Validate required fields ----
  const title = process.env.SURVEY_TITLE ?? '';
  try {
    validateTitle(title);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

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

  const deadline = process.env.SURVEY_DEADLINE ?? '';
  try {
    validateDeadline(deadline);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const targetsRaw = process.env.SURVEY_TARGETS;
  let targets;
  try {
    const parsed = targetsRaw ? JSON.parse(targetsRaw) : undefined;
    targets = validateTargets(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`SURVEY_TARGETS must be valid JSON: ${targetsRaw}`);
  }

  const creator = process.env.SURVEY_CREATOR ?? '';
  try {
    validateCreator(creator);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const anonymous = process.env.SURVEY_ANONYMOUS === 'true';
  const description = process.env.SURVEY_DESC ?? '';

  // ---- Step 2: Generate survey ID and resolve path ----
  const surveyId = generateSurveyId();
  const surveyDir = resolve(SURVEY_DIR);
  await mkdir(surveyDir, { recursive: true });

  const surveyFile = resolve(surveyDir, `${surveyId}.json`);

  // Path traversal protection
  if (!surveyFile.startsWith(surveyDir + '/')) {
    exit(`Path traversal detected for survey ID '${surveyId}'`);
  }

  // Check uniqueness (extremely unlikely collision but be safe)
  try {
    await stat(surveyFile);
    exit(`Survey file ${surveyId}.json already exists (collision, please retry)`);
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code !== 'ENOENT') {
      throw new Error(`Failed to check survey file: ${err}`);
    }
  }

  // ---- Step 3: Write survey file ----
  const surveyData: SurveyFile = {
    id: surveyId,
    title: title!,
    description,
    createdAt: nowISO(),
    createdBy: creator!,
    deadline: deadline!,
    anonymous,
    targetUsers: targets,
    questions,
    responses: {},
    status: 'active',
  };

  // Atomic write: write to temp file then rename
  const tmpFile = `${surveyFile}.${Date.now()}.tmp`;
  await writeFile(tmpFile, JSON.stringify(surveyData, null, 2) + '\n', 'utf-8');
  await rename(tmpFile, surveyFile);

  // Output survey ID for downstream use
  console.log(JSON.stringify({ id: surveyId, status: 'created' }));
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

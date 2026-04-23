#!/usr/bin/env tsx
/**
 * survey/record-response.ts — Record a user's response to a survey question.
 *
 * Environment variables:
 *   SURVEY_ID       (required) Survey identifier
 *   RESPONDER       (required) Responder's open ID
 *   QUESTION_INDEX  (required) Question index (0-based)
 *   OPTION_INDEX    (required) Selected option index (0-based)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  validateResponder,
  validateQuestionIndex,
  validateOptionIndex,
  parseSurveyFile,
  responseKey,
  isExpired,
  ValidationError,
  SURVEY_DIR,
  nowISO,
} from './schema.js';
import { withExclusiveLock } from '../chat/lock.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  // ---- Validate inputs ----
  const surveyId = process.env.SURVEY_ID;
  try {
    validateSurveyId(surveyId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const responder = process.env.RESPONDER;
  try {
    validateResponder(responder ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Load survey file ----
  const filePath = resolve(SURVEY_DIR, `${surveyId}.json`);
  let surveyJson: string;
  try {
    surveyJson = await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      exit(`Survey '${surveyId}' not found`);
    }
    throw err;
  }

  let survey;
  try {
    survey = parseSurveyFile(surveyJson, filePath);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Validate survey state ----
  if (survey.status === 'closed') {
    exit(`Survey '${surveyId}' is closed`);
  }
  if (survey.status === 'expired' || isExpired(survey.deadline)) {
    exit(`Survey '${surveyId}' has expired (deadline: ${survey.deadline})`);
  }

  // ---- Validate question and option indices ----
  const questionIndex = validateQuestionIndex(process.env.QUESTION_INDEX, survey.questions.length);
  const optionIndex = validateOptionIndex(process.env.OPTION_INDEX, survey.questions[questionIndex].options.length);

  // ---- Check if target is allowed (if targets specified) ----
  if (survey.targets.length > 0 && !survey.targets.includes(responder)) {
    exit(`Responder '${responder}' is not a target of survey '${surveyId}'`);
  }

  // ---- Record response under exclusive lock ----
  const lockPath = `${filePath}.lock`;
  await withExclusiveLock(lockPath, async () => {
    // Re-read under lock to prevent TOCTOU
    const currentJson = await readFile(filePath, 'utf-8');
    const currentSurvey = parseSurveyFile(currentJson, filePath);

    // Re-check status under lock
    if (currentSurvey.status === 'closed' || currentSurvey.status === 'expired' || isExpired(currentSurvey.deadline)) {
      exit(`Survey '${surveyId}' is no longer accepting responses`);
    }

    const key = responseKey(responder!, questionIndex);
    if (currentSurvey.responses[key]) {
      // Already responded — update (allow changing answer)
      console.log(`WARN: Overwriting existing response for '${key}'`);
    }

    currentSurvey.responses[key] = {
      responder: responder!,
      questionIndex,
      optionIndex,
      respondedAt: nowISO(),
    };

    // Write atomically
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    await writeFile(tmpPath, JSON.stringify(currentSurvey, null, 2), 'utf-8');
    await rename(tmpPath, filePath);
  });

  const question = survey.questions[questionIndex];
  console.log(JSON.stringify({
    success: true,
    message: `Response recorded: Q${questionIndex} = "${question.options[optionIndex]}"`,
    survey: {
      id: survey.id,
      questionIndex,
      optionIndex,
      optionText: question.options[optionIndex],
    },
  }));
}

main().catch((err) => {
  exit(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});

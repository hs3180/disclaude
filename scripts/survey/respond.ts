#!/usr/bin/env tsx
/**
 * survey/respond.ts — Record a survey response.
 *
 * Environment variables:
 *   SURVEY_ID           (required) Survey ID
 *   SURVEY_RESPONDER    (required) Responder's open ID
 *   SURVEY_QUESTION_ID  (required) Question ID (e.g. "q1")
 *   SURVEY_ANSWER       (required) The answer text
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
  validateQuestionId,
  validateAnswer,
  parseSurveyFile,
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
  // ---- Step 1: Validate inputs ----
  const surveyId = process.env.SURVEY_ID ?? '';
  try {
    validateSurveyId(surveyId);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const responder = process.env.SURVEY_RESPONDER ?? '';
  try {
    validateResponder(responder);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const questionId = process.env.SURVEY_QUESTION_ID ?? '';
  try {
    validateQuestionId(questionId);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const answer = process.env.SURVEY_ANSWER ?? '';
  try {
    validateAnswer(answer);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 2: Read and validate survey file ----
  const surveyFile = resolve(SURVEY_DIR, `${surveyId}.json`);

  let rawJson: string;
  try {
    rawJson = await readFile(surveyFile, 'utf-8');
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      exit(`Survey '${surveyId}' not found`);
    }
    throw new Error(`Failed to read survey file: ${err}`);
  }

  const survey = parseSurveyFile(rawJson, surveyFile);

  // ---- Step 3: Validate business rules ----
  if (survey.status === 'closed') {
    exit(`Survey '${surveyId}' is closed (deadline: ${survey.deadline})`);
  }

  // Verify question exists
  const question = survey.questions.find((q) => q.id === questionId);
  if (!question) {
    exit(`Question '${questionId}' not found in survey '${surveyId}'`);
  }

  // Validate answer against question type
  if (question.type === 'single_choice') {
    if (!question.options?.includes(answer)) {
      exit(`Invalid answer '${answer}' for question '${questionId}'. Valid options: ${question.options?.join(', ')}`);
    }
  }

  // ---- Step 4: Record response ----
  if (!survey.responses[responder]) {
    survey.responses[responder] = {};
  }
  survey.responses[responder][questionId] = answer;

  // Check if all questions answered → mark completedAt
  const allQuestionIds = survey.questions.map((q) => q.id);
  const responderAnswers = survey.responses[responder];
  const answeredAll = allQuestionIds.every((qid) => qid in responderAnswers && responderAnswers[qid] !== undefined);
  if (answeredAll) {
    responderAnswers.completedAt = nowISO();
  }

  // ---- Step 5: Atomic write ----
  const tmpFile = `${surveyFile}.${Date.now()}.tmp`;
  await writeFile(tmpFile, JSON.stringify(survey, null, 2) + '\n', 'utf-8');
  await rename(tmpFile, surveyFile);

  // Output result
  const responseCount = Object.keys(survey.responses).length;
  const completedCount = Object.values(survey.responses).filter(
    (r) => r.completedAt !== undefined,
  ).length;

  console.log(JSON.stringify({
    id: surveyId,
    responder,
    questionId,
    answeredAll,
    totalResponses: responseCount,
    completedResponses: completedCount,
    totalTargets: survey.targetUsers.length,
  }));
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

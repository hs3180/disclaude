#!/usr/bin/env tsx
/**
 * survey/response.ts — Record a user's response to a survey question.
 *
 * Updates the survey file with the user's answer. Supports updating
 * an existing response (changing vote) or recording a new one.
 *
 * Environment variables:
 *   SURVEY_ID           (required) Survey identifier
 *   SURVEY_RESPONDER    (required) Responder's open ID (ou_xxx format)
 *   SURVEY_QUESTION_ID  (required) Question ID (e.g. "q1")
 *   SURVEY_ANSWER       (required) The selected option value
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
  type SurveyResponse,
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

  // Path traversal protection
  const surveyDir = resolve(SURVEY_DIR);
  if (!surveyFile.startsWith(surveyDir + '/')) {
    exit(`Path traversal detected for survey ID '${surveyId}'`);
  }

  let rawJson: string;
  try {
    rawJson = await readFile(surveyFile, 'utf-8');
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      exit(`Survey ${surveyId} not found`);
    }
    throw err;
  }

  const survey: SurveyFile = parseSurveyFile(rawJson, surveyFile);

  // ---- Step 3: Check survey state ----
  if (survey.status === 'closed') {
    exit(`Survey ${surveyId} is closed and no longer accepts responses`);
  }

  const now = new Date();
  const expiry = new Date(survey.expiresAt);
  if (expiry <= now) {
    exit(`Survey ${surveyId} has expired (expired at ${survey.expiresAt})`);
  }

  // ---- Step 4: Validate question exists ----
  const question = survey.questions.find((q) => q.id === questionId);
  if (!question) {
    const validIds = survey.questions.map((q) => q.id).join(', ');
    exit(`Question '${questionId}' not found in survey. Valid question IDs: ${validIds}`);
  }

  // ---- Step 5: Validate answer is a valid option ----
  const validOption = question.options.find((opt) => opt.value === answer);
  if (!validOption) {
    const validValues = question.options.map((opt) => `'${opt.value}' (${opt.text})`).join(', ');
    exit(`Invalid answer '${answer}' for question '${questionId}'. Valid options: ${validValues}`);
  }

  // ---- Step 6: Record response ----
  if (!survey.responses) {
    survey.responses = {};
  }

  const existingResponse = survey.responses[responder];
  if (existingResponse) {
    // Update existing response (allow changing vote)
    existingResponse.answers[questionId] = answer;
    existingResponse.answeredAt = nowISO();
  } else {
    // New response
    const newResponse: SurveyResponse = {
      responder,
      answeredAt: nowISO(),
      answers: { [questionId]: answer },
    };
    survey.responses[responder] = newResponse;
  }

  // ---- Step 7: Atomic write ----
  const tmpFile = `${surveyFile}.${Date.now()}.tmp`;
  await writeFile(tmpFile, JSON.stringify(survey, null, 2) + '\n', 'utf-8');
  await rename(tmpFile, surveyFile);

  const isUpdate = existingResponse ? 'updated' : 'recorded';
  const totalResponses = Object.keys(survey.responses).length;
  console.log(`OK: Response ${isUpdate} for survey ${surveyId}, question ${questionId}. Answer: "${validOption.text}" (${totalResponses} total respondent(s))`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

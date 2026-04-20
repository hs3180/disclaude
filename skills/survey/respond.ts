#!/usr/bin/env tsx
/**
 * survey/respond.ts — Record a user's response to a survey.
 *
 * Environment variables:
 *   SURVEY_ID             (required) Survey identifier
 *   SURVEY_RESPONDER      (required) Responder's open ID
 *   SURVEY_RESPONSES      (required) JSON object of { questionId: answer }
 *
 * Exit codes:
 *   0 — success
 *   1 — error
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  parseSurveyFile,
  nowISO,
  SURVEY_DIR,
  MEMBER_ID_REGEX,
  MAX_ANSWER_LENGTH,
  ValidationError,
  type SurveyFile,
  type SurveyResponse,
} from './schema.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function validateResponder(responder: string): void {
  if (!responder) {
    throw new ValidationError('SURVEY_RESPONDER environment variable is required');
  }
  if (!MEMBER_ID_REGEX.test(responder)) {
    throw new ValidationError(`Invalid responder ID '${responder}' — expected ou_xxxxx format`);
  }
}

function validateAnswers(
  answers: unknown,
  questions: SurveyFile['questions'],
): Record<string, string> {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new ValidationError('SURVEY_RESPONSES must be a JSON object');
  }

  const result: Record<string, string> = {};
  const answersObj = answers as Record<string, unknown>;

  for (const q of questions) {
    const answer = answersObj[q.id];

    // Check required questions
    if (q.required && (answer === undefined || answer === null || answer === '')) {
      throw new ValidationError(`Required question '${q.id}' (${q.question}) is not answered`);
    }

    // Skip optional unanswered questions
    if (answer === undefined || answer === null || answer === '') {
      continue;
    }

    if (typeof answer !== 'string') {
      throw new ValidationError(`Answer for '${q.id}' must be a string`);
    }

    if (answer.length > MAX_ANSWER_LENGTH) {
      throw new ValidationError(
        `Answer for '${q.id}' too long (${answer.length} chars, max ${MAX_ANSWER_LENGTH})`,
      );
    }

    // Validate single_choice answers
    if (q.type === 'single_choice' && q.options) {
      if (!q.options.includes(answer)) {
        throw new ValidationError(
          `Answer '${answer}' for question '${q.id}' is not a valid option. Valid: ${q.options.join(', ')}`,
        );
      }
    }

    result[q.id] = answer;
  }

  return result;
}

async function main() {
  const surveyId = process.env.SURVEY_ID;
  try {
    validateSurveyId(surveyId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const responder = process.env.SURVEY_RESPONDER;
  try {
    validateResponder(responder ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const responsesRaw = process.env.SURVEY_RESPONSES;
  let responses: Record<string, string>;
  try {
    const parsed = responsesRaw ? JSON.parse(responsesRaw) : undefined;
    if (!parsed) {
      throw new ValidationError('SURVEY_RESPONSES environment variable is required');
    }
    // We validate answers against questions later after loading survey
    responses = parsed;
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`SURVEY_RESPONSES must be valid JSON: ${responsesRaw}`);
  }

  // ---- Load survey ----
  const surveyDir = resolve(SURVEY_DIR);
  const filePath = resolve(surveyDir, `${surveyId}.json`);

  // Path traversal protection
  if (!filePath.startsWith(surveyDir + '/')) {
    exit(`Path traversal detected for survey ID '${surveyId}'`);
  }

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      exit(`Survey '${surveyId}' not found`);
    }
    throw err;
  }

  let survey: SurveyFile;
  try {
    survey = parseSurveyFile(content, filePath);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Validate survey state ----
  if (survey.status !== 'open') {
    exit(`Survey '${surveyId}' is ${survey.status}, cannot accept responses`);
  }

  // Check expiry
  const now = new Date();
  const expiry = new Date(survey.expiresAt);
  if (now > expiry) {
    exit(`Survey '${surveyId}' has expired (expired at ${survey.expiresAt})`);
  }

  // Validate that responder is a target user
  if (!survey.targetUsers.includes(responder!)) {
    exit(`User '${responder}' is not a target user for survey '${surveyId}'`);
  }

  // ---- Validate answers ----
  let validatedAnswers: Record<string, string>;
  try {
    validatedAnswers = validateAnswers(responses, survey.questions);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Check for duplicate response (idempotency: reject overwrite) ----
  if (survey.responses[responder!]) {
    exit(`User '${responder}' has already responded to survey '${surveyId}'`);
  }

  // ---- Record response ----
  const surveyResponse: SurveyResponse = {
    responder: responder!,
    repliedAt: nowISO(),
    answers: validatedAnswers,
  };

  survey.responses[responder!] = surveyResponse;

  // Atomic write
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, JSON.stringify(survey, null, 2) + '\n', 'utf-8');
  await rename(tmpFile, filePath);

  const totalResponses = Object.keys(survey.responses).length;
  console.log(`OK: Response recorded for survey '${surveyId}'`);
  console.log(`User: ${responder}`);
  console.log(`Answers: ${JSON.stringify(validatedAnswers)}`);
  console.log(`Progress: ${totalResponses} / ${survey.targetUsers.length} responses`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

#!/usr/bin/env tsx
/**
 * survey/respond.ts — Record a response to a survey.
 *
 * Environment variables:
 *   SURVEY_ID           (required) Survey identifier
 *   SURVEY_RESPONDENT   (required) Open ID of the respondent (ou_xxx)
 *   SURVEY_ANSWERS      (required) JSON object mapping question IDs to answers
 *                                e.g. '{"q1":"opt2","q2":"Some text"}'
 *                                For multiple_choice: '{"q1":["opt1","opt3"]}'
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or write failure
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  parseSurveyFile,
  nowISO,
  SURVEY_DIR,
  USER_ID_REGEX,
  ANON_ID_REGEX,
  QUESTION_ID_REGEX,
  OPTION_ID_REGEX,
  MAX_TEXT_ANSWER_LENGTH,
  MAX_RESPONSES_SIZE,
  ValidationError,
  type SurveyFile,
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

  // ---- Step 2: Validate respondent ----
  const respondent = process.env.SURVEY_RESPONDENT;
  if (!respondent) {
    exit('SURVEY_RESPONDENT is required');
  }
  if (!USER_ID_REGEX.test(respondent) && !ANON_ID_REGEX.test(respondent)) {
    exit(`Invalid respondent ID '${respondent}' — expected ou_xxxxx or anon_xxxxx format`);
  }

  // ---- Step 3: Validate answers ----
  const answersRaw = process.env.SURVEY_ANSWERS;
  let answers: Record<string, string | string[]>;
  try {
    answers = answersRaw ? JSON.parse(answersRaw) : undefined;
  } catch {
    exit(`SURVEY_ANSWERS must be valid JSON: ${answersRaw}`);
  }
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    exit('SURVEY_ANSWERS must be a JSON object');
  }

  // ---- Step 4: Read survey file ----
  const surveyFile = resolve(SURVEY_DIR, `${surveyId}.json`);
  let survey: SurveyFile;
  try {
    const content = await readFile(surveyFile, 'utf-8');
    survey = parseSurveyFile(content, surveyFile);
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`Survey '${surveyId}' not found`);
  }

  // ---- Step 5: Check survey status ----
  if (survey.status !== 'active') {
    exit(`Survey '${surveyId}' is not active (status: ${survey.status})`);
  }

  // ---- Step 6: Check expiry ----
  if (new Date(survey.expiresAt) <= new Date()) {
    exit(`Survey '${surveyId}' has expired`);
  }

  // ---- Step 7: Check for duplicate response ----
  const respondentKey = survey.anonymous ? `anon_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : respondent;
  if (!survey.anonymous && survey.responses[respondent]) {
    exit(`Respondent '${respondent}' has already submitted a response to survey '${surveyId}'`);
  }

  // ---- Step 8: Validate answers against questions ----
  const questionMap = new Map(survey.questions.map(q => [q.id, q]));

  for (const [questionId, answer] of Object.entries(answers)) {
    if (!QUESTION_ID_REGEX.test(questionId)) {
      exit(`Invalid question ID in answers: '${questionId}'`);
    }

    const question = questionMap.get(questionId);
    if (!question) {
      exit(`Question '${questionId}' does not exist in survey '${surveyId}'`);
    }

    if (question.type === 'single_choice') {
      if (typeof answer !== 'string') {
        exit(`Answer for question '${questionId}' must be a string (single choice)`);
      }
      if (!OPTION_ID_REGEX.test(answer)) {
        exit(`Invalid option ID '${answer}' for question '${questionId}'`);
      }
      const validOptions = question.options?.map(o => o.id) ?? [];
      if (!validOptions.includes(answer)) {
        exit(`Option '${answer}' is not a valid option for question '${questionId}'`);
      }
    } else if (question.type === 'multiple_choice') {
      if (!Array.isArray(answer)) {
        exit(`Answer for question '${questionId}' must be an array (multiple choice)`);
      }
      const validOptions = question.options?.map(o => o.id) ?? [];
      for (const opt of answer) {
        if (typeof opt !== 'string' || !OPTION_ID_REGEX.test(opt)) {
          exit(`Invalid option ID '${opt}' in answer for question '${questionId}'`);
        }
        if (!validOptions.includes(opt)) {
          exit(`Option '${opt}' is not a valid option for question '${questionId}'`);
        }
      }
    } else if (question.type === 'text') {
      if (typeof answer !== 'string') {
        exit(`Answer for question '${questionId}' must be a string (text)`);
      }
      if (answer.length > MAX_TEXT_ANSWER_LENGTH) {
        exit(`Answer for question '${questionId}' too long (${answer.length} chars, max ${MAX_TEXT_ANSWER_LENGTH})`);
      }
    }
  }

  // Check required questions are answered
  for (const q of survey.questions) {
    if (q.required && !(q.id in answers)) {
      exit(`Required question '${q.id}' is not answered`);
    }
  }

  // ---- Step 9: Record response ----
  const response = {
    respondent: respondentKey,
    submittedAt: nowISO(),
    answers,
  };

  survey.responses[respondentKey] = response;

  // Check total responses size
  const responsesSize = JSON.stringify(survey.responses).length;
  if (responsesSize > MAX_RESPONSES_SIZE) {
    exit(`Responses data too large (${responsesSize} bytes, max ${MAX_RESPONSES_SIZE})`);
  }

  // Atomic write
  const tmpFile = `${surveyFile}.${Date.now()}.tmp`;
  await writeFile(tmpFile, JSON.stringify(survey, null, 2) + '\n', 'utf-8');
  await rename(tmpFile, surveyFile);

  const totalResponses = Object.keys(survey.responses).length;
  console.log(`OK: Response recorded for survey '${surveyId}' (${totalResponses} total responses)`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

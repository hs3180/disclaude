#!/usr/bin/env tsx
/**
 * survey/results.ts — Get aggregated results for a survey.
 *
 * Outputs a JSON object with:
 *   - Survey metadata (title, description, status, response count)
 *   - Per-question aggregated results
 *   - For choice questions: vote counts and percentages
 *   - For text questions: list of responses
 *
 * Environment variables:
 *   SURVEY_ID  (required) Survey identifier
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  parseSurveyFile,
  SURVEY_DIR,
  ValidationError,
  type SurveyFile,
  type SurveyQuestion,
} from './schema.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

interface ChoiceResult {
  optionId: string;
  label: string;
  count: number;
  percentage: number;
}

interface QuestionResult {
  questionId: string;
  question: string;
  type: string;
  totalResponses: number;
  results: ChoiceResult[] | string[];
}

interface SurveyResults {
  id: string;
  title: string;
  description: string;
  status: string;
  anonymous: boolean;
  totalRespondents: number;
  targetUserCount: number;
  completionRate: number;
  createdAt: string;
  expiresAt: string;
  questions: QuestionResult[];
}

function aggregateChoiceQuestion(
  question: SurveyQuestion,
  responses: Record<string, { answers: Record<string, string | string[]> }>,
): QuestionResult {
  const optionCounts = new Map<string, number>();
  for (const opt of question.options ?? []) {
    optionCounts.set(opt.id, 0);
  }

  let totalResponses = 0;

  for (const response of Object.values(responses)) {
    const answer = response.answers[question.id];
    if (answer === undefined) continue;

    totalResponses++;

    if (question.type === 'single_choice' && typeof answer === 'string') {
      optionCounts.set(answer, (optionCounts.get(answer) ?? 0) + 1);
    } else if (question.type === 'multiple_choice' && Array.isArray(answer)) {
      for (const opt of answer) {
        optionCounts.set(opt, (optionCounts.get(opt) ?? 0) + 1);
      }
    }
  }

  const results: ChoiceResult[] = (question.options ?? []).map(opt => ({
    optionId: opt.id,
    label: opt.label,
    count: optionCounts.get(opt.id) ?? 0,
    percentage: totalResponses > 0 ? Math.round(((optionCounts.get(opt.id) ?? 0) / totalResponses) * 100) : 0,
  }));

  return {
    questionId: question.id,
    question: question.question,
    type: question.type,
    totalResponses,
    results,
  };
}

function aggregateTextQuestion(
  question: SurveyQuestion,
  responses: Record<string, { answers: Record<string, string | string[]> }>,
): QuestionResult {
  const textAnswers: string[] = [];

  for (const response of Object.values(responses)) {
    const answer = response.answers[question.id];
    if (typeof answer === 'string' && answer.length > 0) {
      textAnswers.push(answer);
    }
  }

  return {
    questionId: question.id,
    question: question.question,
    type: question.type,
    totalResponses: textAnswers.length,
    results: textAnswers,
  };
}

async function main() {
  // ---- Step 1: Validate survey ID ----
  const surveyId = process.env.SURVEY_ID;
  try {
    validateSurveyId(surveyId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 2: Read survey file ----
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

  // ---- Step 3: Aggregate results ----
  const totalRespondents = Object.keys(survey.responses).length;
  const completionRate = survey.targetUsers.length > 0
    ? Math.round((totalRespondents / survey.targetUsers.length) * 100)
    : 0;

  const questionResults: QuestionResult[] = survey.questions.map(q => {
    if (q.type === 'text') {
      return aggregateTextQuestion(q, survey.responses);
    }
    return aggregateChoiceQuestion(q, survey.responses);
  });

  const results: SurveyResults = {
    id: survey.id,
    title: survey.title,
    description: survey.description,
    status: survey.status,
    anonymous: survey.anonymous,
    totalRespondents,
    targetUserCount: survey.targetUsers.length,
    completionRate,
    createdAt: survey.createdAt,
    expiresAt: survey.expiresAt,
    questions: questionResults,
  };

  // Output as JSON
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

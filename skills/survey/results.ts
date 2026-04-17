#!/usr/bin/env tsx
/**
 * survey/results.ts — Aggregate and display survey results.
 *
 * Environment variables:
 *   SURVEY_ID  (required) Survey identifier
 *
 * Output: JSON object with aggregated results per question.
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or read failure
 *
 * @module skills/survey/results
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
  option: string;
  count: number;
  percentage: string;
}

interface TextResult {
  answers: string[];
  count: number;
}

interface QuestionResult {
  questionId: string;
  questionText: string;
  questionType: string;
  totalResponses: number;
  results: ChoiceResult[] | TextResult;
}

interface SurveyResults {
  surveyId: string;
  title: string;
  status: string;
  totalRespondents: number;
  targetCount: number;
  completionRate: string;
  questions: QuestionResult[];
}

function aggregateChoiceQuestion(
  question: SurveyQuestion,
  responses: SurveyFile['responses'],
  isMultiple: boolean,
): QuestionResult {
  const optionCounts: Record<string, number> = {};
  for (const option of question.options ?? []) {
    optionCounts[option] = 0;
  }

  let totalResponses = 0;

  for (const response of Object.values(responses)) {
    const answer = response.answers[question.id];
    if (answer === undefined) continue;

    totalResponses++;

    if (isMultiple && Array.isArray(answer)) {
      for (const item of answer) {
        optionCounts[item] = (optionCounts[item] || 0) + 1;
      }
    } else if (typeof answer === 'string') {
      optionCounts[answer] = (optionCounts[answer] || 0) + 1;
    }
  }

  const results: ChoiceResult[] = (question.options ?? []).map((option) => ({
    option,
    count: optionCounts[option] || 0,
    percentage: totalResponses > 0
      ? `${((optionCounts[option] / totalResponses) * 100).toFixed(1)}%`
      : '0%',
  }));

  // Sort by count descending
  results.sort((a, b) => b.count - a.count);

  return {
    questionId: question.id,
    questionText: question.text,
    questionType: question.type,
    totalResponses,
    results,
  };
}

function aggregateTextQuestion(
  question: SurveyQuestion,
  responses: SurveyFile['responses'],
): QuestionResult {
  const answers: string[] = [];

  for (const response of Object.values(responses)) {
    const answer = response.answers[question.id];
    if (answer !== undefined && typeof answer === 'string') {
      answers.push(answer);
    }
  }

  return {
    questionId: question.id,
    questionText: question.text,
    questionType: question.type,
    totalResponses: answers.length,
    results: {
      answers,
      count: answers.length,
    },
  };
}

async function main() {
  // ---- Step 1: Validate inputs ----
  const surveyId = process.env.SURVEY_ID;
  try {
    validateSurveyId(surveyId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // ---- Step 2: Read and validate survey file ----
  const surveyFile = resolve(SURVEY_DIR, `${surveyId}.json`);

  let json: string;
  try {
    json = await readFile(surveyFile, 'utf-8');
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      exit(`Survey ${surveyId} not found`);
    }
    exit(`Failed to read survey file: ${err}`);
  }

  const survey = parseSurveyFile(json, surveyFile);
  const totalRespondents = Object.keys(survey.responses).length;

  // ---- Step 3: Aggregate results per question ----
  const questionResults: QuestionResult[] = survey.questions.map((question) => {
    switch (question.type) {
      case 'single_choice':
        return aggregateChoiceQuestion(question, survey.responses, false);
      case 'multiple_choice':
        return aggregateChoiceQuestion(question, survey.responses, true);
      case 'text':
        return aggregateTextQuestion(question, survey.responses);
      default:
        throw new ValidationError(`Unknown question type '${question.type}'`);
    }
  });

  // ---- Step 4: Output results ----
  const results: SurveyResults = {
    surveyId: survey.id,
    title: survey.title,
    status: survey.status,
    totalRespondents,
    targetCount: survey.targetUsers.length,
    completionRate: survey.targetUsers.length > 0
      ? `${((totalRespondents / survey.targetUsers.length) * 100).toFixed(1)}%`
      : 'N/A',
    questions: questionResults,
  };

  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

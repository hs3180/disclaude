#!/usr/bin/env tsx
/**
 * survey/results.ts — Aggregate and display survey results.
 *
 * Environment variables:
 *   SURVEY_ID  (required) Survey ID
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or read failure
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

interface QuestionResult {
  id: string;
  type: string;
  question: string;
  totalResponses: number;
  choiceResults?: ChoiceResult[];
  textResponses?: string[];
}

interface SurveyResults {
  id: string;
  title: string;
  anonymous: boolean;
  status: string;
  deadline: string;
  totalTargets: number;
  totalResponded: number;
  completedResponses: number;
  questions: QuestionResult[];
}

function aggregateChoiceQuestion(
  survey: SurveyFile,
  question: SurveyQuestion,
): QuestionResult {
  const choiceResults: ChoiceResult[] = (question.options ?? []).map((option) => {
    let count = 0;
    for (const response of Object.values(survey.responses)) {
      if (response[question.id] === option) {
        count++;
      }
    }
    return { option, count, percentage: '' };
  });

  const total = choiceResults.reduce((sum, c) => sum + c.count, 0);
  for (const c of choiceResults) {
    c.percentage = total > 0 ? ((c.count / total) * 100).toFixed(1) : '0.0';
  }

  // Sort by count descending
  choiceResults.sort((a, b) => b.count - a.count);

  const totalResponses = Object.values(survey.responses).filter(
    (r) => r[question.id] !== undefined,
  ).length;

  return {
    id: question.id,
    type: question.type,
    question: question.question,
    totalResponses,
    choiceResults,
  };
}

function aggregateTextQuestion(
  survey: SurveyFile,
  question: SurveyQuestion,
): QuestionResult {
  const textResponses: string[] = [];
  for (const response of Object.values(survey.responses)) {
    const answer = response[question.id];
    if (answer !== undefined) {
      textResponses.push(answer);
    }
  }

  const totalResponses = textResponses.length;

  return {
    id: question.id,
    type: question.type,
    question: question.question,
    totalResponses,
    textResponses,
  };
}

async function main() {
  // ---- Step 1: Validate inputs ----
  const surveyId = process.env.SURVEY_ID ?? '';
  try {
    validateSurveyId(surveyId);
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

  // ---- Step 3: Aggregate results ----
  const totalResponded = Object.keys(survey.responses).length;
  const completedResponses = Object.values(survey.responses).filter(
    (r) => r.completedAt !== undefined,
  ).length;

  const questionResults: QuestionResult[] = survey.questions.map((q) => {
    if (q.type === 'single_choice') {
      return aggregateChoiceQuestion(survey, q);
    }
    return aggregateTextQuestion(survey, q);
  });

  const results: SurveyResults = {
    id: survey.id,
    title: survey.title,
    anonymous: survey.anonymous,
    status: survey.status,
    deadline: survey.deadline,
    totalTargets: survey.targetUsers.length,
    totalResponded,
    completedResponses,
    questions: questionResults,
  };

  // Output as JSON
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

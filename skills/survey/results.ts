#!/usr/bin/env tsx
/**
 * survey/results.ts — Query survey results and generate a summary.
 *
 * Environment variables:
 *   SURVEY_ID  (required) Survey identifier
 *
 * Output: JSON with per-question vote counts and responder list
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  parseSurveyFile,
  isExpired,
  ValidationError,
  SURVEY_DIR,
} from './schema.js';

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

  // ---- Aggregate results ----
  const results = survey.questions.map((q) => {
    const counts: Record<number, number> = {};
    for (let i = 0; i < q.options.length; i++) {
      counts[i] = 0;
    }

    const responders: string[] = [];
    for (const resp of Object.values(survey.responses)) {
      if (resp.questionIndex === q.index) {
        counts[resp.optionIndex] = (counts[resp.optionIndex] ?? 0) + 1;
        if (!responders.includes(resp.responder)) {
          responders.push(resp.responder);
        }
      }
    }

    const totalVotes = Object.values(counts).reduce((s, c) => s + c, 0);

    return {
      question: q.text,
      type: q.type,
      options: q.options.map((opt, i) => ({
        text: opt,
        votes: counts[i] ?? 0,
        percentage: totalVotes > 0 ? Math.round((counts[i] / totalVotes) * 100) : 0,
      })),
      totalVotes,
      responderCount: responders.length,
    };
  });

  // Check auto-expire
  const expired = isExpired(survey.deadline);
  if (expired && survey.status === 'open') {
    survey.status = 'expired';
  }

  // Count unique responders
  const uniqueResponders = new Set<string>();
  for (const resp of Object.values(survey.responses)) {
    uniqueResponders.add(resp.responder);
  }

  const output = {
    success: true,
    survey: {
      id: survey.id,
      title: survey.title,
      description: survey.description,
      status: survey.status,
      anonymous: survey.anonymous,
      deadline: survey.deadline,
      targetCount: survey.targets.length,
      totalResponders: uniqueResponders.size,
      isExpired: expired,
    },
    results,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  exit(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});

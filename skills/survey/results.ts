#!/usr/bin/env tsx
/**
 * survey/results.ts — Aggregate and display survey results.
 *
 * Environment variables:
 *   SURVEY_ID (required) Survey identifier
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or file not found
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  parseSurveyFile,
  SURVEY_DIR,
  ValidationError,
} from './schema.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  const surveyId = process.env.SURVEY_ID;
  try {
    validateSurveyId(surveyId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const surveyDir = resolve(SURVEY_DIR);
  const surveyFile = resolve(surveyDir, `${surveyId}.json`);

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

  const survey = parseSurveyFile(rawJson, surveyFile);

  const totalParticipants = survey.participants.length;
  const totalResponses = survey.responses.length;
  const participationRate = totalParticipants > 0
    ? Math.round((totalResponses / totalParticipants) * 100)
    : 0;

  // Output as JSON for programmatic consumption
  const result = {
    id: survey.id,
    title: survey.title,
    status: survey.status,
    totalParticipants,
    totalResponses,
    participationRate,
    anonymous: survey.anonymous,
    createdAt: survey.createdAt,
    deadline: survey.deadline,
    closedAt: survey.closedAt,
    questions: survey.questions.map((q, qi) => {
      const questionResult: Record<string, unknown> = {
        index: qi,
        text: q.text,
        type: q.type,
        totalResponses: totalResponses,
      };

      if (q.type === 'single_choice') {
        // Count votes for each option
        const optionCounts: Record<string, number> = {};
        for (const opt of q.options) {
          optionCounts[opt] = 0;
        }
        for (const resp of survey.responses) {
          const ans = resp.answers[String(qi)];
          if (typeof ans === 'string' && optionCounts[ans] !== undefined) {
            optionCounts[ans]++;
          }
        }
        questionResult.options = Object.entries(optionCounts).map(([option, count]) => ({
          option,
          count,
          percentage: totalResponses > 0 ? Math.round((count / totalResponses) * 100) : 0,
        }));
      } else if (q.type === 'multiple_choice') {
        const optionCounts: Record<string, number> = {};
        for (const opt of q.options) {
          optionCounts[opt] = 0;
        }
        for (const resp of survey.responses) {
          const ans = resp.answers[String(qi)];
          if (Array.isArray(ans)) {
            for (const a of ans) {
              if (optionCounts[a] !== undefined) {
                optionCounts[a]++;
              }
            }
          }
        }
        questionResult.options = Object.entries(optionCounts).map(([option, count]) => ({
          option,
          count,
          percentage: totalResponses > 0 ? Math.round((count / totalResponses) * 100) : 0,
        }));
      } else {
        // text question — collect all answers
        const textAnswers: string[] = [];
        for (const resp of survey.responses) {
          const ans = resp.answers[String(qi)];
          if (typeof ans === 'string') {
            textAnswers.push(ans);
          }
        }
        questionResult.answers = textAnswers;
      }

      return questionResult;
    }),
  };

  // Output JSON result
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

#!/usr/bin/env tsx
/**
 * survey/results.ts — Aggregate and display survey results.
 *
 * Environment variables:
 *   SURVEY_ID  (required) Survey identifier
 *
 * Exit codes:
 *   0 — success
 *   1 — error
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  parseSurveyFile,
  SURVEY_DIR,
  ValidationError,
  type SurveyFile,
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

  const totalResponses = Object.keys(survey.responses).length;
  const totalTargets = survey.targetUsers.length;
  const completionRate = totalTargets > 0 ? ((totalResponses / totalTargets) * 100).toFixed(1) : '0';

  console.log(`📊 Survey Results: ${survey.title}`);
  console.log(`> **Status**: ${survey.status === 'open' ? '🟢 Open' : '🔴 Closed'}`);
  console.log(`> **Completion**: ${totalResponses} / ${totalTargets} (${completionRate}%)`);
  console.log(`> **Anonymous**: ${survey.anonymous ? 'Yes' : 'No'}`);
  console.log('');

  // Aggregate results per question
  for (const q of survey.questions) {
    console.log(`### ${q.id}. ${q.question} [${q.type}]`);

    if (q.type === 'single_choice' && q.options) {
      // Count responses for each option
      const counts: Record<string, number> = {};
      for (const opt of q.options) {
        counts[opt] = 0;
      }
      let answeredCount = 0;

      for (const resp of Object.values(survey.responses)) {
        const answer = resp.answers[q.id];
        if (answer && counts[answer] !== undefined) {
          counts[answer]++;
          answeredCount++;
        }
      }

      // Display as bar chart
      for (const opt of q.options) {
        const count = counts[opt];
        const pct = answeredCount > 0 ? ((count / answeredCount) * 100).toFixed(0) : '0';
        const bar = '█'.repeat(Math.round(Number(pct) / 5));
        console.log(`  ${opt}: ${bar} ${count} (${pct}%)`);
      }
      console.log(`  Total answers: ${answeredCount}`);
    } else if (q.type === 'text') {
      // List all text responses
      const textAnswers: string[] = [];
      for (const resp of Object.values(survey.responses)) {
        const answer = resp.answers[q.id];
        if (answer) {
          if (survey.anonymous) {
            textAnswers.push(answer);
          } else {
            textAnswers.push(`[${resp.responder}] ${answer}`);
          }
        }
      }

      if (textAnswers.length === 0) {
        console.log('  (no responses)');
      } else {
        for (const ans of textAnswers) {
          console.log(`  - ${ans}`);
        }
      }
      console.log(`  Total answers: ${textAnswers.length}`);
    }

    console.log('');
  }

  // List who hasn't responded (non-anonymous only)
  if (!survey.anonymous) {
    const respondedUsers = new Set(Object.keys(survey.responses));
    const pendingUsers = survey.targetUsers.filter((u) => !respondedUsers.has(u));

    if (pendingUsers.length > 0) {
      console.log(`### ⏳ Pending responses (${pendingUsers.length})`);
      for (const user of pendingUsers) {
        console.log(`  - ${user}`);
      }
    }
  }

  // Output raw JSON for programmatic consumption
  console.log(`\n---RAW_JSON---`);
  console.log(JSON.stringify(survey, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

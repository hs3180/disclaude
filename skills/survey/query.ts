#!/usr/bin/env tsx
/**
 * survey/query.ts — Query survey status.
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

  // Output structured info
  const statusEmoji = survey.status === 'open' ? '🟢' : survey.status === 'closed' ? '🔵' : '🔴';
  const totalParticipants = survey.participants.length;
  const totalResponses = survey.responses.length;
  const participationRate = totalParticipants > 0
    ? Math.round((totalResponses / totalParticipants) * 100)
    : 0;
  const isExpired = new Date(survey.deadline) <= new Date();

  console.log(`📋 Survey: ${survey.id}`);
  console.log(`  Title: ${survey.title}`);
  console.log(`  Status: ${statusEmoji} ${survey.status}${isExpired && survey.status === 'open' ? ' (expired, pending closure)' : ''}`);
  console.log(`  Description: ${survey.description || '(none)'}`);
  console.log(`  Questions: ${survey.questions.length}`);
  console.log(`  Participants: ${totalParticipants}`);
  console.log(`  Responses: ${totalResponses}/${totalParticipants} (${participationRate}%)`);
  console.log(`  Anonymous: ${survey.anonymous ? 'Yes' : 'No'}`);
  console.log(`  Created: ${survey.createdAt}`);
  console.log(`  Deadline: ${survey.deadline}`);
  if (survey.closedAt) {
    console.log(`  Closed: ${survey.closedAt}`);
  }

  // List non-respondents (if not anonymous)
  if (!survey.anonymous && survey.status === 'open') {
    const responders = new Set(survey.responses.map((r) => r.responder));
    const nonRespondents = survey.participants.filter((p) => !responders.has(p));
    if (nonRespondents.length > 0) {
      console.log(`  Pending: ${nonRespondents.join(', ')}`);
    }
  }

  // Questions summary
  console.log('');
  console.log('Questions:');
  survey.questions.forEach((q, i) => {
    const typeLabel = q.type === 'single_choice' ? '单选' : q.type === 'multiple_choice' ? '多选' : '文本';
    console.log(`  ${i + 1}. [${typeLabel}${q.required ? ', 必填' : ', 选填'}] ${q.text}`);
    if (q.options.length > 0) {
      q.options.forEach((opt) => {
        const count = survey.responses.filter((r) => {
          const ans = r.answers[String(i)];
          if (Array.isArray(ans)) return ans.includes(opt);
          return ans === opt;
        }).length;
        console.log(`     - ${opt}: ${count} 票`);
      });
    }
  });
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

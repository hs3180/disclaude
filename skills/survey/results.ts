#!/usr/bin/env tsx
/**
 * survey/results.ts — Aggregate and display survey results.
 *
 * Reads a survey file and outputs a formatted summary of responses,
 * including per-question vote tallies and percentages.
 *
 * Environment variables:
 *   SURVEY_ID  (required) Survey identifier
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
} from './schema.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

interface QuestionResult {
  questionId: string;
  question: string;
  totalVotes: number;
  options: {
    value: string;
    text: string;
    count: number;
    percentage: string;
  }[];
}

function computeResults(survey: SurveyFile): QuestionResult[] {
  const results: QuestionResult[] = [];
  const totalRespondents = Object.keys(survey.responses).length;

  for (const q of survey.questions) {
    // Count votes for each option
    const voteCounts = new Map<string, number>();
    for (const opt of q.options) {
      voteCounts.set(opt.value, 0);
    }

    let questionVotes = 0;
    for (const resp of Object.values(survey.responses)) {
      const answer = resp.answers[q.id];
      if (answer !== undefined) {
        const current = voteCounts.get(answer) ?? 0;
        voteCounts.set(answer, current + 1);
        questionVotes++;
      }
    }

    const optionResults = q.options.map((opt) => {
      const count = voteCounts.get(opt.value) ?? 0;
      const pct = questionVotes > 0 ? ((count / questionVotes) * 100).toFixed(1) : '0.0';
      return {
        value: opt.value,
        text: opt.text,
        count,
        percentage: pct,
      };
    });

    // Sort by count descending
    optionResults.sort((a, b) => b.count - a.count);

    results.push({
      questionId: q.id,
      question: q.question,
      totalVotes: questionVotes,
      options: optionResults,
    });
  }

  return results;
}

function formatResults(survey: SurveyFile, results: QuestionResult[]): string {
  const totalRespondents = Object.keys(survey.responses).length;
  const lines: string[] = [];

  lines.push(`📊 **${survey.title}** — Results`);
  if (survey.description) {
    lines.push(`_${survey.description}_`);
  }
  lines.push(`> **Status**: ${survey.status === 'active' ? '🟢 Active' : '🔴 Closed'}`);
  lines.push(`> **Respondents**: ${totalRespondents}`);
  lines.push(`> **Expires**: ${survey.expiresAt}`);
  lines.push('');

  for (const qr of results) {
    lines.push(`### ${qr.questionId}: ${qr.question}`);
    lines.push(`(${qr.totalVotes} vote${qr.totalVotes !== 1 ? 's' : ''})`);
    lines.push('');

    for (const opt of qr.options) {
      const bar = '█'.repeat(Math.round(parseFloat(opt.percentage) / 5));
      const padBar = bar.padEnd(20, '░');
      lines.push(`- **${opt.text}**: ${opt.count} (${opt.percentage}%) ${padBar}`);
    }
    lines.push('');
  }

  // Completion rate per question
  if (totalRespondents > 0) {
    lines.push('### Completion Rates');
    lines.push('');
    for (const qr of results) {
      const rate = ((qr.totalVotes / totalRespondents) * 100).toFixed(1);
      lines.push(`- ${qr.questionId}: ${qr.totalVotes}/${totalRespondents} (${rate}%)`);
    }
  }

  return lines.join('\n');
}

async function main() {
  // ---- Step 1: Validate survey ID ----
  const surveyId = process.env.SURVEY_ID ?? '';
  try {
    validateSurveyId(surveyId);
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

  // ---- Step 3: Compute and display results ----
  const results = computeResults(survey);
  const formatted = formatResults(survey, results);
  console.log(formatted);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

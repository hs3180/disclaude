#!/usr/bin/env npx tsx
/**
 * Aggregate and display survey results.
 *
 * Reads the survey JSON, computes statistics per question,
 * and outputs a human-readable summary plus machine-readable JSON.
 *
 * Environment variables:
 *   SURVEY_ID - Survey identifier (required)
 *
 * @module skills/survey/results
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { getSurveyPath, type Survey } from './schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

interface ChoiceStat {
  option: string;
  count: number;
  percentage: string;
}

interface QuestionResult {
  questionId: string;
  questionText: string;
  type: string;
  totalResponses: number;
  /** For choice-type questions */
  choiceStats?: ChoiceStat[];
  /** For text-type questions */
  textResponses?: string[];
}

interface SurveyResults {
  surveyId: string;
  title: string;
  status: string;
  anonymous: boolean;
  totalTargetUsers: number;
  totalResponses: number;
  responseRate: string;
  questions: QuestionResult[];
}

function computeResults(survey: Survey): SurveyResults {
  const totalTargetUsers = survey.targetUsers.length;
  const totalResponses = survey.responses.length;
  const responseRate = totalTargetUsers > 0
    ? `${Math.round((totalResponses / totalTargetUsers) * 100)}%`
    : 'N/A';

  const questionResults: QuestionResult[] = survey.questions.map(q => {
    // Collect all answers for this question
    const answers = survey.responses
      .map(r => r.answers.find(a => a.questionId === q.id))
      .filter((a): a is NonNullable<typeof a> => a !== undefined);

    const result: QuestionResult = {
      questionId: q.id,
      questionText: q.text,
      type: q.type,
      totalResponses: answers.length,
    };

    if (q.type === 'single_choice' && q.options) {
      // Count votes for each option
      const counts = new Map<string, number>();
      for (const opt of q.options) counts.set(opt, 0);
      for (const a of answers) {
        const val = Array.isArray(a.value) ? a.value[0] : a.value;
        counts.set(val, (counts.get(val) ?? 0) + 1);
      }
      result.choiceStats = q.options.map(opt => {
        const count = counts.get(opt) ?? 0;
        return {
          option: opt,
          count,
          percentage: answers.length > 0
            ? `${Math.round((count / answers.length) * 100)}%`
            : '0%',
        };
      });
    } else if (q.type === 'multiple_choice' && q.options) {
      // Count each option (users can select multiple)
      const counts = new Map<string, number>();
      for (const opt of q.options) counts.set(opt, 0);
      for (const a of answers) {
        const vals = Array.isArray(a.value) ? a.value : [a.value];
        for (const v of vals) {
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
      }
      result.choiceStats = q.options.map(opt => {
        const count = counts.get(opt) ?? 0;
        return {
          option: opt,
          count,
          percentage: answers.length > 0
            ? `${Math.round((count / answers.length) * 100)}%`
            : '0%',
        };
      });
    } else if (q.type === 'text') {
      result.textResponses = answers.map(a => {
        const val = Array.isArray(a.value) ? a.value.join(', ') : a.value;
        return val;
      });
    }

    return result;
  });

  return {
    surveyId: survey.id,
    title: survey.title,
    status: survey.status,
    anonymous: survey.anonymous,
    totalTargetUsers,
    totalResponses,
    responseRate,
    questions: questionResults,
  };
}

function formatResults(results: SurveyResults): string {
  const lines: string[] = [];

  lines.push(`📊 Survey Results: ${results.title}`);
  lines.push(`   Status: ${results.status} | Response Rate: ${results.responseRate} (${results.totalResponses}/${results.totalTargetUsers})`);
  if (results.anonymous) lines.push('   🔒 Anonymous survey');
  lines.push('');

  for (const q of results.questions) {
    lines.push(`❓ ${q.questionText} (${q.type}, ${q.totalResponses} response(s))`);

    if (q.choiceStats) {
      for (const cs of q.choiceStats) {
        const bar = '█'.repeat(Math.max(1, Math.round(parseInt(cs.percentage) / 5)));
        lines.push(`   ${cs.option}: ${bar} ${cs.count} (${cs.percentage})`);
      }
    } else if (q.textResponses) {
      for (let i = 0; i < q.textResponses.length; i++) {
        lines.push(`   ${i + 1}. ${q.textResponses[i]}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const surveyId = requireEnv('SURVEY_ID');
  const filePath = getSurveyPath(surveyId);

  if (!existsSync(filePath)) {
    throw new Error(`Survey "${surveyId}" not found`);
  }

  const raw = await readFile(filePath, 'utf-8');
  const survey: Survey = JSON.parse(raw);

  const results = computeResults(survey);
  const formatted = formatResults(results);

  // Output both machine-readable and human-readable
  console.log(JSON.stringify({
    success: true,
    results,
    formatted,
  }));
}

main().catch((err: Error) => {
  console.error(JSON.stringify({
    success: false,
    error: err.message,
  }));
  process.exit(1);
});

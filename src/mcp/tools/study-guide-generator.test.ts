/**
 * Tests for Study Guide Generator Tools.
 *
 * @module mcp/tools/study-guide-generator.test
 */

import { describe, it, expect } from 'vitest';
import {
  generate_summary,
  generate_qa_pairs,
  generate_flashcards,
  generate_quiz,
  create_study_guide,
  type SummaryOptions,
  type QAGeneratorOptions,
  type FlashcardGeneratorOptions,
  type QuizGeneratorOptions,
  type StudyGuideOptions,
} from './study-guide-generator.js';

const sampleContent = `
# Introduction to Machine Learning

Machine Learning is a subset of artificial intelligence (AI) that enables systems to learn and improve from experience without being explicitly programmed.

## Types of Machine Learning

### Supervised Learning
Supervised learning uses labeled data to train models. The algorithm learns from examples where the correct answer is known.
Common algorithms include Linear Regression, Decision Trees, and Neural Networks.

### Unsupervised Learning
Unsupervised learning finds patterns in unlabeled data. The algorithm discovers hidden structures without predefined labels.
Common algorithms include K-means clustering and Principal Component Analysis (PCA).

### Reinforcement Learning
Reinforcement learning trains agents to make decisions by rewarding desired behaviors and punishing undesired ones.
Applications include game playing, robotics, and autonomous vehicles.

## Key Concepts

- **Training Data**: The dataset used to train the model
- **Features**: Input variables used for predictions
- **Labels**: Output variables in supervised learning
- **Model**: The learned representation of the data
- **Accuracy**: Measure of how often the model makes correct predictions
`;

describe('generate_summary', () => {
  it('should generate a summary with default options', () => {
    const result = generate_summary({ content: sampleContent });

    expect(result.success).toBe(true);
    expect(result.summary).toBeDefined();
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.wordCount).toBeGreaterThan(0);
    expect(result.summary).toContain('bullet');
  });

  it('should generate a brief summary', () => {
    const options: SummaryOptions = {
      content: sampleContent,
      style: 'brief',
      maxLength: 100,
    };
    const result = generate_summary(options);

    expect(result.success).toBe(true);
    expect(result.summary).toContain('brief');
    expect(result.summary).toContain('100');
  });

  it('should generate a detailed summary', () => {
    const options: SummaryOptions = {
      content: sampleContent,
      style: 'detailed',
      maxLength: 500,
    };
    const result = generate_summary(options);

    expect(result.success).toBe(true);
    expect(result.summary).toContain('detailed');
    expect(result.summary).toContain('comprehensive');
  });

  it('should generate a bullet-point summary', () => {
    const options: SummaryOptions = {
      content: sampleContent,
      style: 'bullet',
      maxLength: 200,
    };
    const result = generate_summary(options);

    expect(result.success).toBe(true);
    expect(result.summary).toContain('bullet');
  });

  it('should fail with empty content', () => {
    const result = generate_summary({ content: '' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  it('should fail with whitespace-only content', () => {
    const result = generate_summary({ content: '   \n\t  ' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  it('should count words correctly', () => {
    const content = 'one two three four five';
    const result = generate_summary({ content });

    expect(result.wordCount).toBe(5);
  });
});

describe('generate_qa_pairs', () => {
  it('should generate Q&A pairs with default options', () => {
    const result = generate_qa_pairs({ content: sampleContent });

    expect(result.success).toBe(true);
    expect(result.qaPairs).toHaveLength(1);
    expect(result.count).toBe(5);
  });

  it('should generate specified number of pairs', () => {
    const options: QAGeneratorOptions = {
      content: sampleContent,
      count: 10,
    };
    const result = generate_qa_pairs(options);

    expect(result.success).toBe(true);
    expect(result.count).toBe(10);
  });

  it('should include focus topics when specified', () => {
    const options: QAGeneratorOptions = {
      content: sampleContent,
      count: 3,
      focusTopics: ['Supervised Learning', 'Neural Networks'],
    };
    const result = generate_qa_pairs(options);

    expect(result.success).toBe(true);
    expect(result.qaPairs[0]?.question).toContain('Supervised Learning');
    expect(result.qaPairs[0]?.question).toContain('Neural Networks');
  });

  it('should exclude difficulty when disabled', () => {
    const options: QAGeneratorOptions = {
      content: sampleContent,
      count: 5,
      includeDifficulty: false,
    };
    const result = generate_qa_pairs(options);

    expect(result.success).toBe(true);
    expect(result.qaPairs[0]?.question).not.toContain('difficulty level');
  });

  it('should fail with empty content', () => {
    const result = generate_qa_pairs({ content: '' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });
});

describe('generate_flashcards', () => {
  it('should generate flashcards with default options', () => {
    const result = generate_flashcards({ content: sampleContent });

    expect(result.success).toBe(true);
    expect(result.flashcards).toHaveLength(1);
    expect(result.count).toBe(10);
    expect(result.flashcards[0]?.deck).toBe('Study Deck');
  });

  it('should use custom deck name', () => {
    const options: FlashcardGeneratorOptions = {
      content: sampleContent,
      deckName: 'ML Fundamentals',
    };
    const result = generate_flashcards(options);

    expect(result.success).toBe(true);
    expect(result.flashcards[0]?.deck).toBe('ML Fundamentals');
  });

  it('should generate specified number of cards', () => {
    const options: FlashcardGeneratorOptions = {
      content: sampleContent,
      count: 20,
    };
    const result = generate_flashcards(options);

    expect(result.count).toBe(20);
  });

  it('should generate Anki format when requested', () => {
    const options: FlashcardGeneratorOptions = {
      content: sampleContent,
      format: 'anki',
      deckName: 'Test Deck',
    };
    const result = generate_flashcards(options);

    expect(result.success).toBe(true);
    expect(result.ankiOutput).toBeDefined();
    expect(result.ankiOutput).toContain('Test Deck');
    expect(result.ankiOutput).toContain('Front\tBack\tTags');
  });

  it('should generate CSV format when requested', () => {
    const options: FlashcardGeneratorOptions = {
      content: sampleContent,
      format: 'csv',
    };
    const result = generate_flashcards(options);

    expect(result.success).toBe(true);
    expect(result.csvOutput).toBeDefined();
    expect(result.csvOutput).toContain('Front,Back,Tags');
  });

  it('should fail with empty content', () => {
    const result = generate_flashcards({ content: '' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });
});

describe('generate_quiz', () => {
  it('should generate quiz with default options', () => {
    const result = generate_quiz({ content: sampleContent });

    expect(result.success).toBe(true);
    expect(result.questions).toHaveLength(1);
    expect(result.count).toBe(10);
    expect(result.totalPoints).toBe(100);
  });

  it('should generate specified number of questions', () => {
    const options: QuizGeneratorOptions = {
      content: sampleContent,
      count: 20,
    };
    const result = generate_quiz(options);

    expect(result.count).toBe(20);
  });

  it('should calculate points per question correctly', () => {
    const options: QuizGeneratorOptions = {
      content: sampleContent,
      count: 10,
      totalPoints: 100,
    };
    const result = generate_quiz(options);

    expect(result.questions[0]?.points).toBe(10);
  });

  it('should include specified question types', () => {
    const options: QuizGeneratorOptions = {
      content: sampleContent,
      count: 5,
      questionTypes: ['multiple_choice', 'true_false'],
    };
    const result = generate_quiz(options);

    expect(result.success).toBe(true);
    expect(result.questions[0]?.question).toContain('multiple_choice');
    expect(result.questions[0]?.question).toContain('true_false');
  });

  it('should include markdown quiz output', () => {
    const result = generate_quiz({ content: sampleContent });

    expect(result.markdownQuiz).toBeDefined();
    expect(result.markdownQuiz).toContain('# Quiz');
    expect(result.markdownQuiz).toContain('Total Questions');
    expect(result.markdownQuiz).toContain('Total Points');
  });

  it('should include explanations when enabled', () => {
    const options: QuizGeneratorOptions = {
      content: sampleContent,
      includeExplanations: true,
    };
    const result = generate_quiz(options);

    expect(result.questions[0]?.explanation).toBeDefined();
  });

  it('should exclude explanations when disabled', () => {
    const options: QuizGeneratorOptions = {
      content: sampleContent,
      includeExplanations: false,
    };
    const result = generate_quiz(options);

    expect(result.questions[0]?.explanation).toBeUndefined();
  });

  it('should fail with empty content', () => {
    const result = generate_quiz({ content: '' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });
});

describe('create_study_guide', () => {
  it('should create a complete study guide', () => {
    const result = create_study_guide({ content: sampleContent });

    expect(result.success).toBe(true);
    expect(result.studyGuide).toBeDefined();
    expect(result.studyGuide).toContain('# Study Guide');
    expect(result.studyGuide).toContain('## Summary');
    expect(result.studyGuide).toContain('## Q&A Pairs');
    expect(result.studyGuide).toContain('## Flashcards');
    expect(result.studyGuide).toContain('## Quiz');
  });

  it('should use custom title', () => {
    const options: StudyGuideOptions = {
      content: sampleContent,
      title: 'Machine Learning Study Guide',
    };
    const result = create_study_guide(options);

    expect(result.studyGuide).toContain('# Machine Learning Study Guide');
  });

  it('should include only specified components', () => {
    const options: StudyGuideOptions = {
      content: sampleContent,
      include: {
        summary: true,
        qa: false,
        flashcards: false,
        quiz: false,
      },
    };
    const result = create_study_guide(options);

    expect(result.studyGuide).toContain('## Summary');
    expect(result.studyGuide).not.toContain('## Q&A Pairs');
    expect(result.studyGuide).not.toContain('## Flashcards');
    expect(result.studyGuide).not.toContain('## Quiz');
  });

  it('should return components', () => {
    const result = create_study_guide({ content: sampleContent });

    expect(result.components.summary).toBeDefined();
    expect(result.components.qa).toBeDefined();
    expect(result.components.flashcards).toBeDefined();
    expect(result.components.quiz).toBeDefined();
  });

  it('should fail with empty content', () => {
    const result = create_study_guide({ content: '' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  it('should include generation date', () => {
    const result = create_study_guide({ content: sampleContent });

    expect(result.studyGuide).toContain('Generated on');
    expect(result.studyGuide).toMatch(/\d{4}-\d{2}-\d{2}/); // Date format YYYY-MM-DD
  });
});

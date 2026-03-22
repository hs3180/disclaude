/**
 * Output Validator - Detects hallucination/garbage content in model outputs.
 *
 * Issue #1332: GLM-5 and other models may occasionally produce garbled or
 * hallucinated content that should not be sent to users.
 *
 * This module provides heuristics to detect such problematic outputs:
 * - Broken code fragments mixed with text
 * - Template syntax errors (e.g., ${时间} instead of actual values)
 * - High density of code keywords but not valid code
 * - Incomplete syntax structures
 *
 * @module utils/output-validator
 */

import { createLogger } from './logger.js';

const logger = createLogger('OutputValidator');

/**
 * Result of output validation.
 */
export interface OutputValidationResult {
  /** Whether the output is valid and can be sent to users */
  valid: boolean;
  /** Reason for rejection (if invalid) */
  reason?: string;
  /** Confidence score (0-1) for the decision */
  confidence: number;
  /** Details about detected issues */
  issues: string[];
}

/**
 * Configuration for output validation.
 */
export interface OutputValidatorConfig {
  /** Enable/disable validation (default: true) */
  enabled?: boolean;
  /** Minimum content length to validate (short content is always valid) */
  minLength?: number;
  /** Threshold for code keyword density (0-1) */
  codeKeywordDensityThreshold?: number;
  /** Threshold for broken template patterns */
  brokenTemplateThreshold?: number;
}

const DEFAULT_CONFIG: Required<OutputValidatorConfig> = {
  enabled: true,
  minLength: 50,
  codeKeywordDensityThreshold: 0.15,
  brokenTemplateThreshold: 2,
};

/**
 * Patterns that indicate potential hallucination/garbage content.
 */
const HALLUCINATION_PATTERNS = {
  // Broken template syntax like ${时间}, ${_substr}, etc.
  brokenTemplate: /\$\{[^}]*[\u4e00-\u9fa5]+[^}]*\}|\$\{_[a-zA-Z_]+\}/g,

  // Incomplete arrow function syntax
  incompleteArrow: /=>\s*\$\{|=>\s*\.\.\.|=>\s*undefined\s*\?/g,

  // Broken ternary expressions
  brokenTernary: /\?\s*\.\s*:/g,

  // Invalid property access like . )
  invalidPropertyAccess: /\.\s*\)/g,

  // Broken regex or replace patterns
  brokenRegex: /\.replace\s*\(\s*\/[^\/]*\/[gimsuy]*\s*,\s*['"`]/g,

  // Unmatched braces in content (not in code blocks)
  unmatchedBraces: /\}\s*\.\s*`|\{\s*\.\s*\}/g,

  // Mixed language fragments (Chinese + broken code)
  mixedLanguageCode: /[\u4e00-\u9fa5]+\s*\.\s*(function|return|const|let|var|if|else)/gi,
};

/**
 * Code keywords that might indicate fragmented code output.
 */
const CODE_KEYWORDS = [
  'function', 'return', 'const', 'let', 'var', 'if', 'else', 'for', 'while',
  'class', 'interface', 'type', 'import', 'export', 'async', 'await',
  'try', 'catch', 'throw', 'new', 'this', 'super', 'extends', 'implements',
];

/**
 * Validates model output for potential hallucination or garbage content.
 *
 * @param content - The content to validate
 * @param config - Validation configuration
 * @returns Validation result with details
 */
export function validateOutput(
  content: string,
  config: OutputValidatorConfig = {}
): OutputValidationResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Disabled validation
  if (!cfg.enabled) {
    return { valid: true, confidence: 1, issues: [] };
  }

  // Short content is always valid
  if (content.length < cfg.minLength) {
    return { valid: true, confidence: 1, issues: [] };
  }

  const issues: string[] = [];
  let suspicionScore = 0;

  // Check for broken template patterns
  const brokenTemplateMatches = content.match(HALLUCINATION_PATTERNS.brokenTemplate);
  if (brokenTemplateMatches && brokenTemplateMatches.length >= cfg.brokenTemplateThreshold) {
    issues.push(`Found ${brokenTemplateMatches.length} broken template patterns (e.g., \${中文变量})`);
    suspicionScore += 0.3 * Math.min(brokenTemplateMatches.length, 3);
  }

  // Check for incomplete arrow function syntax
  if (HALLUCINATION_PATTERNS.incompleteArrow.test(content)) {
    issues.push('Found incomplete arrow function syntax');
    suspicionScore += 0.2;
  }

  // Check for broken ternary expressions
  if (HALLUCINATION_PATTERNS.brokenTernary.test(content)) {
    issues.push('Found broken ternary expressions');
    suspicionScore += 0.2;
  }

  // Check for invalid property access
  if (HALLUCINATION_PATTERNS.invalidPropertyAccess.test(content)) {
    issues.push('Found invalid property access patterns');
    suspicionScore += 0.15;
  }

  // Check for mixed language code fragments
  const mixedLanguageMatches = content.match(HALLUCINATION_PATTERNS.mixedLanguageCode);
  if (mixedLanguageMatches && mixedLanguageMatches.length >= 2) {
    issues.push(`Found ${mixedLanguageMatches.length} mixed language code fragments`);
    suspicionScore += 0.2 * Math.min(mixedLanguageMatches.length, 3);
  }

  // Check code keyword density
  const codeKeywordDensity = calculateCodeKeywordDensity(content);
  if (codeKeywordDensity > cfg.codeKeywordDensityThreshold) {
    // High keyword density alone is not enough; check if it's valid code
    const isValidCode = checkIfValidCode(content);
    if (!isValidCode) {
      issues.push(`High code keyword density (${(codeKeywordDensity * 100).toFixed(1)}%) but not valid code structure`);
      suspicionScore += 0.25;
    }
  }

  // Check for unmatched code block markers
  const codeBlockCount = (content.match(/```/g) || []).length;
  if (codeBlockCount % 2 !== 0) {
    issues.push('Unmatched code block markers');
    suspicionScore += 0.1;
  }

  // Calculate final confidence and decision
  const confidence = Math.max(0, Math.min(1, 1 - suspicionScore));
  const valid = suspicionScore < 0.5;

  if (!valid) {
    logger.warn(
      { issues, suspicionScore, contentLength: content.length, contentPreview: content.slice(0, 200) },
      'Output validation failed - potential hallucination detected'
    );
  }

  return {
    valid,
    reason: valid ? undefined : `Potential hallucination: ${issues.join('; ')}`,
    confidence,
    issues,
  };
}

/**
 * Calculate the density of code keywords in content.
 */
function calculateCodeKeywordDensity(content: string): number {
  const words = content.split(/[\s\n\r\t{}()\[\];,.<>:'"=+\-*/\\|&^!@#$%?]+/);
  const codeWords = words.filter(word =>
    CODE_KEYWORDS.includes(word.toLowerCase())
  );

  if (words.length === 0) return 0;
  return codeWords.length / words.length;
}

/**
 * Check if content appears to be valid code structure.
 * This is a heuristic check - not a full parser.
 */
function checkIfValidCode(content: string): boolean {
  // Check for balanced braces (rough heuristic)
  const openBraces = (content.match(/\{/g) || []).length;
  const closeBraces = (content.match(/\}/g) || []).length;

  // If braces are reasonably balanced, it might be valid code
  if (Math.abs(openBraces - closeBraces) <= 1) {
    // Check for common code patterns
    const hasFunctionPattern = /function\s*\w*\s*\(|=>\s*\{|class\s+\w+/.test(content);
    const hasImportPattern = /import\s+.*from\s+['"]|require\s*\(/.test(content);

    if (hasFunctionPattern || hasImportPattern) {
      return true;
    }
  }

  return false;
}

/**
 * Quick check if content might be problematic.
 * Use this for fast filtering before full validation.
 */
export function quickCheck(content: string): boolean {
  // Very short content is always OK
  if (content.length < 50) return true;

  // Check for obvious red flags
  const redFlags = [
    // Broken template with Chinese
    /\$\{[^}]*[\u4e00-\u9fa5]+/,
    // Incomplete syntax
    /=>\s*\$\{/,
  ];

  for (const pattern of redFlags) {
    if (pattern.test(content)) {
      return false;
    }
  }

  return true;
}

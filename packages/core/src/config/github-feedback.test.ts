import { afterEach, describe, expect, it } from 'vitest';
import { githubFeedbackErrors, resolveGitHubIssueTarget } from './github-feedback.js';
import { knownSecretValues } from './channel-credentials.js';
import type { DisclaudeConfig } from './types.js';

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----\n';

function config(github: unknown): DisclaudeConfig {
  return { github } as DisclaudeConfig;
}

afterEach(() => {
  delete process.env.GITHUB_APP_PRIVATE_KEY;
});

describe('githubFeedbackErrors', () => {
  it('accepts a complete section referencing an external secret', () => {
    expect(
      githubFeedbackErrors(
        config({
          repository: 'hs3180/disclaude',
          appId: '3129570',
          installationId: '117680580',
          privateKey: '$GITHUB_APP_PRIVATE_KEY',
        })
      )
    ).toEqual([]);
  });

  it('ignores an absent section', () => {
    expect(githubFeedbackErrors({})).toEqual([]);
  });

  it('rejects a literal private key in the config file', () => {
    expect(
      githubFeedbackErrors(
        config({
          repository: 'hs3180/disclaude',
          appId: '3129570',
          installationId: '117680580',
          privateKey: PEM,
        })
      )
    ).toContain(
      'github.privateKey must be a whole $VARIABLE or ${VARIABLE} reference (e.g. $GITHUB_APP_PRIVATE_KEY); move the PEM outside the general config'
    );
  });

  it('rejects malformed repository and non-numeric ids', () => {
    const errors = githubFeedbackErrors(
      config({ repository: 'not-a-slug', appId: 'abc', installationId: '12x', privateKey: '$K' })
    );
    expect(errors).toContain('github.repository must be an "owner/name" repository identifier');
    expect(errors).toContain("github.appId must be the GitHub App's numeric app ID");
    expect(errors).toContain(
      "github.installationId must be the GitHub App's numeric installation ID"
    );
  });

  it('rejects a secret sourced from the same config env map', () => {
    const errors = githubFeedbackErrors({
      github: { repository: 'a/b', appId: '1', installationId: '2', privateKey: '$K' },
      env: { K: PEM },
    });
    expect(errors[0]).toContain('github.privateKey references env.K in the same config');
  });
});

describe('resolveGitHubIssueTarget', () => {
  it('returns undefined without a github section', () => {
    expect(resolveGitHubIssueTarget({})).toBeUndefined();
  });

  it('resolves the PEM from the environment and registers it for redaction', () => {
    process.env.GITHUB_APP_PRIVATE_KEY = PEM.replace(/\n/g, '\\n');
    const target = resolveGitHubIssueTarget(
      config({
        repository: 'hs3180/disclaude',
        appId: '3129570',
        installationId: '117680580',
        privateKey: '$GITHUB_APP_PRIVATE_KEY',
      })
    );
    expect(target).toEqual({
      repository: 'hs3180/disclaude',
      appId: '3129570',
      installationId: '117680580',
      privateKey: PEM,
    });
    expect(knownSecretValues()).toContain(PEM);
  });

  it('throws on a missing environment variable', () => {
    expect(() =>
      resolveGitHubIssueTarget(
        config({
          repository: 'hs3180/disclaude',
          appId: '3129570',
          installationId: '117680580',
          privateKey: '$GITHUB_APP_PRIVATE_KEY',
        })
      )
    ).toThrow('environment variable GITHUB_APP_PRIVATE_KEY is missing or empty');
  });

  it('throws on a value that is not a PEM key', () => {
    process.env.GITHUB_APP_PRIVATE_KEY = 'definitely not a key';
    expect(() =>
      resolveGitHubIssueTarget(
        config({
          repository: 'hs3180/disclaude',
          appId: '3129570',
          installationId: '117680580',
          privateKey: '$GITHUB_APP_PRIVATE_KEY',
        })
      )
    ).toThrow('does not contain a PEM private key');
  });
});

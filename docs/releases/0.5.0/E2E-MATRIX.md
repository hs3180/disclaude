# 0.5.0 E2E / integration matrix

The machine-readable source is [`tests/e2e/0.5.0/matrix.json`](../../../tests/e2e/0.5.0/matrix.json).
It maps the release acceptance criteria to executable commands and records what is
actually verified versus what still needs an external backend, channel, or deployment
environment.

## Execution policy

- `contract` cases are safe to run in the normal CI job and use deterministic seams.
- `integration` cases start isolated local services and do not require provider credentials.
- `external` cases are opt-in only; they must not run from the default pull-request CI job.
- `release` cases are the final candidate gate and require collected evidence, not merely a
  successful process exit.
- A case marked `planned` is a visible gap, not a passing result.

The matrix is validated as the first stage of the canonical integration command:

```sh
npm run test:integration
```

The current matrix intentionally leaves DeepSeek, live Codex control, and Docker/launchd
rehearsals as opt-in planned cases until their real credentials and isolated environments
are available.

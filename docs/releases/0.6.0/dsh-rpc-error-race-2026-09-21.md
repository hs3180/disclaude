# DSH RPC error assertion timing audit

Date: 2026-09-21

Baseline: `origin/main` at `1e4c1442`.

## Observed failure

A fresh full regression exposed one failure in `packages/core/src/sdk/providers/deepseek/dsh-transport.test.ts`:

```text
expected: dsh RPC error -32001: fixture failure
received: dsh request timed out: rpc-error (200ms)
```

The fixture sends a deterministic JSON-RPC error, but the first request can spend the 200 ms budget starting a fresh Node fixture under full-suite process and I/O load. The transport's RPC-error conversion was not shown to be incorrect: the same focused test passed in five consecutive runs, and the malformed-frame timeout assertion remained distinct.

## Boundary

This PR is discovery only. It does not change the DSH transport or its test budget. The independent fix PR increases only the fixture startup budget while retaining the exact RPC-error and malformed-frame assertions; it is based directly on `main` and must be reviewed separately.

The failure is test reliability evidence, not a claim of a production DSH protocol defect or a release completion signal.

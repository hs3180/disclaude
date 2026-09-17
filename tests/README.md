# Test entry points

`npm test` runs core behavior checks through `vitest.config.ts`. `npm run test:coverage` runs the same assertions with coverage; CI uses this once, instead of running both commands in successive jobs. `tests/e2e/**` is excluded from this configuration. The RFC 3329 component checks remain in the unit suite under `tests/unit/rfc3329`; their fake message senders and direct component calls do not prove deployed channel behavior.

`npm run test:e2e -- <test-file>` builds the product and runs selected use cases through `vitest.e2e.config.ts`. The E2E configuration retains the shared resource cleanup setup and disables unit coverage. Skipped cases mean the required environment was not supplied, never that the use case passed. Select the case and supply its documented environment; a default run is not release acceptance.

| Use case | Entry under `tests/e2e/` | Actual dependency and evidence boundary |
| --- | --- | --- |
| First-run workspace selection and restart | `workspace-onboarding.test.ts` | Python PTY and product CLI/service; verifies saved workspace, uploads after restart and cancellation without writing configuration. Runs in its own CI job. |
| Browser lifecycle, handoff and diagnosis | `browser-service.test.ts`, `browser-doctor.test.ts`, `browser-smoke.test.ts` | Real Chromium and Python browser harness; dedicated browser CI provides binaries. Model contention requires additional explicit model configuration. |
| Browser setup and persistence | `chromium-launchd.test.ts`, `chromium-systemd.test.ts`, `chromium-setup.test.ts`, `chromium-download.test.ts` | Actual platform service manager and browser; systemd/download CI supplies Linux environment. macOS launchd remains an explicit local case. |
| Container startup, storage and cleanup | `docker-service.test.ts`, `docker-browser-smoke.test.ts`, `docker-cleanup.test.ts` | Actual Docker service/browser images and labelled volumes/networks; dedicated Docker CI also injects a failure to verify cleanup. Optional model execution is separate from the offline container case. |
| Static Feishu card delivery | `static-card-feishu.test.ts` | Explicit authorized test chat and credentials. Real outgoing API/readback with an in-process channel fixture; does not prove incoming WebSocket callbacks or desktop rendering. |
| DeepSeek tool execution | `deepseek-mode.test.ts` | Explicit real model credentials and dsh; invokes the provider directly. This is bounded provider/artifact evidence, not the full deployed chat path. |

Actual package installation remains the separate `npm run test:install:checkout -- --matrix` CI job. `tests/git-release-install.test.ts` checks the generator with local source fixtures; it does not install or start the distribution.

This is the current separation of the Vitest suites, not completion of repository-wide test consolidation (#5016). Historical shell/deployment runners, opt-in model checks within packages, and the bounded provider/channel fixtures above still need review against real product entry points. Retain useful assertions while correcting their evidence labels; do not delete coverage solely because a test uses mocks. Historical release reports describe the candidates and paths used at the time and are not current execution instructions.

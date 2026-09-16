# Docker service runtime acceptance

The service image includes the unified `disclaude` CLI, Codex, and dsh
`0.1.2-rc.1`. The dsh version is configurable with the `DSH_VERSION` build argument;
`DSH_HOME=/data/dsh` belongs to the service user and can be persisted with `/data`.
The image supports both configured DeepSeek modes (`standard` and `minimal`).

`tests/e2e/docker-service.test.ts` exercises the production image rather than a
substitute Dockerfile. It creates only uniquely named test containers and a test
data volume, runs as UID 1001 under the image's real entrypoint/healthcheck, and
checks:

- Unified CLI startup, real health/API readiness, authenticated write routing and
  absence of the old Primary Node package/bin.
- Real dsh `sdk` and `sdk-minimal` initialization using the installed binary and
  product transport. No model prompt or real credential is supplied.
- The REST channel's actual file upload/download, followed by graceful shutdown,
  container removal and recreation with the same volume.
- A persisted UTC command schedule automatically executed by the service before
  and after container recreation, with distinct boot records, schedule/chat IDs
  and the non-root UID verified. The original schedule and execution records
  remain on the data volume.
- Uploaded file metadata/content, workspace and Codex data retained after
  recreation; standard then minimal configuration accepted; clean exit and
  process-lock removal.

```sh
docker build -f Dockerfile.service -t disclaude-service:e2e .
npm ci --include=dev
DISCLAUDE_E2E_DOCKER_IMAGE=disclaude-service:e2e \
  npx vitest run tests/e2e/docker-service.test.ts
```

Without the image environment variable, the case is skipped. The test removes its
own containers and volume, preserves the supplied image, and never prunes shared
Docker resources. It publishes no host ports and uses no existing deployment.
The Linux CI workflow builds a fresh production image and runs this same case.

This covers container lifecycle/storage and command scheduling in #4924. It does not prove
live Feishu auth/callbacks, model-based scheduled turns, browser
fingerprint behavior or migration of an existing deployment. Those require their
own actual-use-case acceptance. A skipped test or successful image build alone is
not a runtime pass.

The config-driven REST channel now supplies persistent file storage by default.
Uploads are committed as complete objects under `fileStorageDir/objects-v1`;
metadata is reloaded after restart and content is checked against its size/hash
when downloaded. An interrupted unpublished object is retained without appearing
as a completed upload. Existing files outside this namespace are preserved but
not automatically imported; this is not an old-deployment storage migration.

An additional opt-in sets `DISCLAUDE_E2E_DOCKER_MODEL=1` and
`DISCLAUDE_E2E_DOCKER_MODEL_ENV_FILE` to a private Docker env file containing
`DEEPSEEK_API_KEY` and, if required, `DEEPSEEK_BASE_URL`. It sends a real REST chat
request in each configured mode, asks the model to create a unique workspace
file through its shell tool, and independently verifies that file. This makes
paid model calls. Default CI omits this option. The env file stays outside the
repository and is passed by path; do not publish it or container metadata.

## Recorded acceptance — 2026-09-16

The Linux/amd64 CI run [34996179925](https://github.com/hs3180/disclaude/actions/runs/34996179925)
built the production image from `703c05896506f8f0fe8a932bd26be855aebd1a98`
and passed the lifecycle and persistent upload case without model credentials.

A local Linux/arm64 image built from the combined acceptance candidate
`0d37828279a62ba88be6fd47615d1dd700e19240` also passed the optional real-model
case in 25.69 seconds. It ran Node 22.23.2 as UID 1001, dsh 0.1.2-rc.1 and
Codex 0.154.0. Both standard and minimal REST conversations created their requested
files through a real model tool call; independent filesystem reads verified the
contents. Upload retention after container recreation and clean exit passed in
both cycles. This is functional evidence, not a comparison of mode performance.

That local candidate combines this PR with the Research, Codex input and status
placeholder changes; it is not the exact Docker PR head. The disk guard interrupted
the final image export, but the imported image was present and passed a separate
executable probe before the runtime case. Its test containers, volume, image and
dedicated builder were removed afterwards. This does not establish a clean build
exit locally; the exact-head CI above supplies the successful build evidence.

Neither run exercises actual Feishu card interaction or a real Codex model turn
inside the container. Those remain separate acceptance items.


The persisted command-schedule case passed on Linux/amd64 in
[run 35026286855](https://github.com/hs3180/disclaude/actions/runs/35026286855)
from `cea8848484ad8624bd1a6e51974af657d216b4e6`, in 20.30 seconds. Both
standard and minimal startup cycles produced a new scheduled execution record;
the second retained the first record and unchanged schedule file. Upload retention
and clean exits also passed. No model call was made in this run.

The preceding run rejected the documented `timezone: UTC` before executing any
schedule. The parser now explicitly accepts UTC, which the Intl supported-values
list omits despite support in the cron runtime. This is a reproduced and fixed
loading defect, not a retry-only acceptance result.


## Browser CLI across separate containers

`tests/e2e/docker-browser-smoke.test.ts` runs the installed browser-use CLI in
the actual service image against the actual Chromium image, in both Xvfb and
headless modes. It enables all eight diagnostic smoke assertions, including
zero Chrome processes in the service container, explicit target cleanup, cold
dead-endpoint refusal and PNG validation. This is the standalone CLI diagnostic;
product coordinator lifecycle is exercised separately by browser-service.test.ts.

Supply both `DISCLAUDE_E2E_DOCKER_IMAGE` and
`DISCLAUDE_E2E_DOCKER_BROWSER_IMAGE` after building the two production images,
then run `npx vitest run tests/e2e/docker-browser-smoke.test.ts`. Without both
image variables, the case skips. The Docker Service E2E workflow builds both
images and enables the case. It uses a dedicated network and disposable
containers, publishes no host ports, and supplies no account credentials.
The service container runs the diagnostic rather than starting message channels.

## Test-resource ownership and failure cleanup

The service E2E labels its service container, short-lived data-operation containers
and data volume with one full UUID in `io.disclaude.e2e-run`. Its teardown enumerates
only that exact label, removes owned containers before volumes, and reports any
remaining resource or Docker error. It does not silently ignore removal failures
or infer ownership from a common name prefix. If Docker is unavailable, inspect
the printed `DOCKER_TEST_RESOURCES` label once access returns; do not run a global
prune. A killed test runner still needs explicit recovery of its recorded Docker
label; the foreground process supervisor cannot reclaim Docker resources (#5049).

`tests/e2e/docker-cleanup.test.ts` exercises actual container/volume cleanup using
an already installed Node-capable image selected by
`DISCLAUDE_E2E_DOCKER_CLEANUP_IMAGE`. It intentionally holds one run's volume from a
second run's container: cleanup must report the in-use volume, preserve the second
container and its sentinel, then succeed after that owner releases it. The test
requires the image to exist and does not pull or build it. This resource test is
not production service-image acceptance.

The service-image test also supports
`DISCLAUDE_E2E_DOCKER_FAIL_AFTER_START=1` to deliberately fail after creating the
service container. This should return a nonzero test result plus
`DOCKER_TEST_CLEANUP`; verify the exact printed label has no remaining containers
or volumes. Do not count an arbitrary failure as successful teardown.


The separate Docker browser smoke case now uses the same exact-label helper for
both containers and its private network. The resource E2E also attaches the peer
to the first run's network: cleanup must report both in-use resources, leave the
peer's data untouched, and reclaim the network only after the peer releases it.
Docker CI runs this resource case alongside the production image tests and verifies
the explicit post-start failure path using the already-built production image.
A helper-only change triggers this CI job as well.


## Opt-in model schedule acceptance

Set `DISCLAUDE_E2E_DOCKER_MODEL_SCHEDULE=1` with the production image and private
`DISCLAUDE_E2E_DOCKER_MODEL_ENV_FILE` described above. This option is independent
of `DISCLAUDE_E2E_DOCKER_MODEL`, which tests direct REST chat. The new case creates
a prompt-based SCHEDULE.md after service readiness. The service watcher loads it
and wall-clock cron triggers it; the test does not call the scheduler or send a
chat request to trigger that task.

A calendar-specific UTC trigger is set 30 seconds ahead using the container clock,
avoiding recurring paid calls during acceptance. The bounded check requires the
scheduler's completed-agent-turn log for the exact task ID, independently reads
the model-created marker/boot/UID artifact, and checks the schedule is unchanged.
It repeats after container recreation in minimal mode and checks that the first
artifact is preserved. Existing owned Docker-resource cleanup runs on success
and failure. Credentials are not enabled in default CI.

**Actual execution — 2026-09-17:** the production Dockerfile built successfully
from `e369b3e8de44085fa1ffa272898df2992b42a089` on Linux ARM64. Image digest:
`sha256:b9390634069953443ddde67b60119c481c55a5852448a40b2a652965c55d2349`.
Runtime: Node 22.23.2, dsh 0.1.2-rc.1, model deepseek-flash, UID 1001.

The first run failed in 38.01 seconds before starting a model: the fixture's
`model-…` chat ID was not recognized by any channel. The REST channel explicitly
owns `rest-…` or UUID IDs. After correcting only this fixture to `rest-model-…`,
the same image passed in 86.40 seconds. Both standard and minimal boots recorded
the exact scheduler completed-agent-turn event and independently verified their
model-created marker/boot/UID artifacts. The second boot retained the first result;
both schedule files remained unchanged, uploaded data persisted, and both exits
were clean. Direct REST model-chat opt-in was disabled in this run.

Both the failed and successful run's labelled containers and volumes were
independently confirmed absent. The private model-env directory, owned buildx
builder and candidate image were removed. Disk space recovered from older test
images and freed VM blocks allowed the build to proceed without relaxing its
space reserve.

This proves actual service watcher/cron/router/dsh/model/tool execution on one
Linux ARM64 image, using explicit tool instructions. It does not establish user
receipt of REST notifications (no waiting REST client was used), actual Feishu
card interaction, other model backends, final-source installation or migration
of existing user data. These remaining #4924 gates are still open; credential-free
CI alone does not repeat this real-model evidence.


## REST client receipt in the model schedule case

The opt-in model schedule case now first establishes an actual asynchronous REST
conversation for the schedule's chat ID. It waits for that initial model reply,
then creates the schedule and, after execution, polls the same HTTP endpoint for
the unique scheduled-result marker. Scheduler logs and the file artifact alone
cannot satisfy this assertion. This adds one short model conversation per mode;
it does not dispatch the scheduled prompt through the chat endpoint.

An unestablished `rest-*` ID currently has no REST inbox: polling returns 204 even
after outgoing text/completion messages. This case covers an established polling
client only, not unsolicited notifications to a new ID, persistent notification
storage across service restarts, or Feishu delivery. A real-HTTP channel probe on
`c6d9f76e` reproduced both behaviors using controlled outgoing messages; that
probe is not model/scheduler end-to-end evidence. The expanded real-model result is recorded below.


**Actual REST receipt — 2026-09-17:** the official Dockerfile.service built from
`075cded8e892109113b1ad746df3397b9574ab46`, image
`sha256:ba4d8b5e16436c535f6018ceb725bae008b87816281d0232e696b39e888ce6ce`,
passed the expanded model schedule case in 88.47 seconds on Linux ARM64.
Both standard and recreated minimal modes returned the unique scheduled marker
through the actual REST polling endpoint, in addition to the completed-agent-turn
log and independent marker/boot/UID1001 artifact checks. Earlier output and uploaded
data survived recreation; schedules stayed unchanged and exits were clean.
Runtime: Node22.23.2, dsh0.1.2-rc.1, deepseek-flash; Codex CLI0.154.0 was installed
but was not the executing model backend. Owned containers/volume were independently
absent after teardown; dedicated builder and image were removed. Production was
unchanged. This does not extend the established-session scope described above.

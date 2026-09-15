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

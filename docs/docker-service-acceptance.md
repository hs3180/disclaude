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

This covers the container lifecycle/storage portion of #4924. It does not prove
live Feishu auth/callbacks, paid model turns, scheduled task execution, browser
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

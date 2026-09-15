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

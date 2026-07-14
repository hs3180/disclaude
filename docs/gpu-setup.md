# GPU Support (optional)

The `primary` service (the compute/agent service that runs Python, Pilot, and
agent task workloads) can optionally use a host GPU. This is **opt-in via
environment variables** — the default configuration is CPU-only and unchanged
by this feature, so hosts without an NVIDIA GPU or `nvidia-container-toolkit`
are not affected.

> Tracked in [issue #4285](https://github.com/hs3180/disclaude/issues/4285).
> This document covers the **part 1** scope: env-driven opt-in via
> `runtime: nvidia` (approach b). See [Open questions](#open-questions-deferred)
> for what is intentionally deferred.
>
> **Scope**: the GPU config applies to `primary`, the only compute service. The
> `worker` / `test-primary` services and `Dockerfile.worker` were removed in
> [#2964](https://github.com/hs3180/disclaude/pull/2964), so the current compose
> has only `primary`, `playwright`, and `filebeat`. (If a worker service is ever
> reintroduced, it should follow the same env-var pattern.)

## Prerequisites

1. **NVIDIA driver** on the host (`nvidia-smi` works).
2. **`nvidia-container-toolkit`** installed:
   ```bash
   # Debian/Ubuntu
   sudo apt-get install -y nvidia-container-toolkit
   sudo systemctl restart docker
   ```
3. **Verify the `nvidia` runtime is registered** with the Docker daemon:
   ```bash
   docker info | grep -i runtime
   # Should list: Runtimes: nvidia runc, Default Runtime: runc
   ```
   If `nvidia` is missing, run `sudo nvidia-ctk runtime configure --runtime=docker`
   and restart Docker.
4. **Docker Compose v2** (the Go `docker compose` CLI, not the legacy Python
   `docker-compose`). The `runtime:` service key is used here.

## Enabling GPU

All variables default to CPU-only-safe values, so you only set the ones you
want to override. Export them in your shell (or your `.env`), then `up`:

```bash
# Minimal: just turn on the nvidia runtime (keeps default shm/memory)
DOCKER_RUNTIME=nvidia docker compose up -d

# Recommended for ML workloads: raise /dev/shm and memory, pick GPUs
DOCKER_RUNTIME=nvidia SHM_SIZE=4G WORKER_MEMORY=40G \
  NVIDIA_VISIBLE_DEVICES=all docker compose up -d
```

| Variable | Default (CPU-only) | GPU example | Purpose |
|---|---|---|---|
| `DOCKER_RUNTIME` | `runc` | `nvidia` | Docker runtime for the `primary` container. `runc` is Docker's standard CPU-only runtime (a no-op); `nvidia` mounts host GPUs. |
| `SHM_SIZE` | `64m` | `4G` | `/dev/shm` size. GPU ML workloads (PyTorch DataLoader `num_workers>0`, torch multiprocessing) crash with `Bus error` on the 64MB default. |
| `WORKER_MEMORY` | `16G` | `40G` | Memory limit for `primary`. GPU ML workloads need far more than the 16G CPU default. |
| `NVIDIA_VISIBLE_DEVICES` | `all` | `all` / `0` / `0,1` | Which GPUs to expose. Interpolated by compose into the container env (set in `.env` or shell); read by the nvidia runtime at container start. |
| `NVIDIA_DRIVER_CAPABILITIES` | `compute,utility` | `compute,utility,graphics` | Driver capabilities exposed by the nvidia runtime. `compute,utility` is the minimum for CUDA/PyTorch. |

## How it works (approach b)

The `primary` service in `docker-compose.yml` reads these via compose
interpolation with safe defaults:

```yaml
primary:
  runtime: ${DOCKER_RUNTIME:-runc}      # → "runc" (Docker's default runtime, no-op) unless overridden
  shm_size: ${SHM_SIZE:-64m}            # → 64m (container default) unless overridden
  deploy:
    resources:
      limits:
        memory: ${WORKER_MEMORY:-16G}   # → 16G (current limit) unless overridden
  environment:
    # read by the nvidia runtime from the container env (not the host shell)
    - NVIDIA_VISIBLE_DEVICES=${NVIDIA_VISIBLE_DEVICES:-all}
    - NVIDIA_DRIVER_CAPABILITIES=${NVIDIA_DRIVER_CAPABILITIES:-compute,utility}
```

This is **approach (b)** from #4285: the Debian (`node:22-trixie-slim`)
`Dockerfile.primary` is kept unchanged, and the GPU is exposed purely through
`runtime: nvidia`. The CUDA / cuDNN runtime is bundled inside the `torch` (and
other ML) wheels that the agent installs at runtime, so no base-image switch to
`nvidia/cuda:...` is required. This mirrors the validated
`/home/mathlab/dockers/jupyter` GPU setup.

## Verifying GPU is available inside the container

```bash
docker compose exec primary python -c "import torch; print(torch.cuda.is_available(), torch.cuda.device_count())"
# Expected: True <N>
```

## Open questions (deferred)

The following were called out in #4285 and are **intentionally not resolved**
by part 1. They need a maintainer decision:

- **Dockerfile base-image decision** (#4285 refined requirement #3, the flagged
  blocker): whether a future `Dockerfile.primary.gpu` based on
  `nvidia/cuda:...-ubuntu` is needed, or whether approach (b) — Debian +
  `runtime: nvidia` + bundled CUDA — is sufficient. Part 1 assumes (b); if ML
  workloads later need system-level CUDA/cuDNN, a separate GPU Dockerfile can be
  added without changing the env interface here.
- **`shm_size` default sizing**: 4G is the validated jupyter value; whether it
  should be larger depends on the workload's typical batch size / `num_workers`.
- **GPU exposure method**: part 1 uses `runtime: nvidia` (jupyter-validated).
  The compose-v2 `deploy.resources.reservations.devices` syntax is an
  alternative; it was avoided here because the empty-default
  `${GPU_DEVICES:-[]}` form can parse-error on some compose versions.

## CPU-only path is unchanged

With none of the variables set, compose interpolates the defaults. The two
`NVIDIA_*` env vars are present but ignored by `runc` (there is no nvidia
runtime to consume them on a CPU host), so the effective behavior is identical
to before:

```yaml
primary:
  runtime: runc         # = Docker's default runtime, a no-op
  shm_size: 64m         # = the container's default /dev/shm
  deploy:
    resources:
      limits:
        memory: 16G     # = the previous hard-coded limit
  environment:
    # present but ignored by runc (no nvidia runtime to consume them)
    - NVIDIA_VISIBLE_DEVICES=all
    - NVIDIA_DRIVER_CAPABILITIES=compute,utility
```

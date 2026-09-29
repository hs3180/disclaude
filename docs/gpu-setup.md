# Optional GPU access in Docker

The service image can use a host NVIDIA GPU through Docker's NVIDIA Container
Toolkit. Install and verify the host driver and toolkit first; Disclaude does
not install or manage them. The normal CPU-only configuration remains the
default.

Enable the NVIDIA runtime:

```sh
DOCKER_RUNTIME=nvidia docker compose up -d service
```

For workloads that need more shared memory or container memory:

```sh
DOCKER_RUNTIME=nvidia SHM_SIZE=4G WORKER_MEMORY=40G \
  NVIDIA_VISIBLE_DEVICES=all docker compose up -d service
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOCKER_RUNTIME` | `runc` | Docker runtime used by the service. Set to `nvidia` to expose GPUs. |
| `SHM_SIZE` | `64m` | Container `/dev/shm` size. Increase for workloads using shared memory. |
| `WORKER_MEMORY` | `16G` | Container memory limit. Adjust to the host and workload. |
| `NVIDIA_VISIBLE_DEVICES` | `all` | GPUs exposed to the service (`all`, `0`, or a comma-separated list). |
| `NVIDIA_DRIVER_CAPABILITIES` | `compute,utility` | NVIDIA driver capabilities exposed inside the container. |

The service image does not include a system CUDA base image. ML frameworks may
bring their own runtime libraries; workloads that require host-level CUDA or
other system libraries need their own image-level validation.

Check GPU visibility inside the running service:

```sh
docker compose exec service python -c "import torch; print(torch.cuda.is_available(), torch.cuda.device_count())"
```

The defaults retain the CPU-only behavior: `runc`, `64m` shared memory, and a
`16G` memory limit. Confirm the rendered Compose configuration and container
runtime on the target host before relying on GPU access.

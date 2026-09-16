import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { cleanupDockerTestResources } from './helpers/docker-resources.js';

const exec = promisify(execFile);
const docker = async (...args: string[]): Promise<string> => (await exec('docker', args, { timeout: 30_000 })).stdout.trim();

describe('run-owned Docker resources', () => {
  it.skipIf(!process.env.DISCLAUDE_E2E_DOCKER_CLEANUP_IMAGE)('reports in-use volume/network resources, preserves a parallel owner, and reclaims after release', async () => {
    const image = process.env.DISCLAUDE_E2E_DOCKER_CLEANUP_IMAGE!;
    // Require a preinstalled Node-capable image; never pull an image for this test.
    await docker('image', 'inspect', image);
    const first = randomUUID(), peer = randomUUID();
    const label = `io.disclaude.e2e-run=${first}`, peerLabel = `io.disclaude.e2e-run=${peer}`;
    const volume = `disclaude-cleanup-${first}`, peerVolume = `disclaude-cleanup-${peer}`;
    const network = `disclaude-cleanup-${first}`;
    const container = `disclaude-cleanup-${first}`, peerContainer = `disclaude-cleanup-${peer}`;
    console.info('DOCKER_CLEANUP_TEST_LABELS', JSON.stringify({ label, peerLabel }));
    try {
      await docker('network', 'create', '--label', label, network);
      await docker('volume', 'create', '--label', label, volume);
      await docker('volume', 'create', '--label', peerLabel, peerVolume);
      await docker('run', '-d', '--init', '--memory', '256m', '--user', '0:0', '--name', container,
        '--label', label, '--network', network, '--entrypoint', 'node', '-v', `${volume}:/data`, image, '-e', 'setInterval(()=>{},1000)');
      await docker('run', '-d', '--init', '--memory', '256m', '--user', '0:0', '--name', peerContainer,
        '--label', peerLabel, '--network', network, '--entrypoint', 'node', '-v', `${volume}:/shared`, '-v', `${peerVolume}:/data`, image, '-e', 'setInterval(()=>{},1000)');
      await docker('exec', peerContainer, 'node', '-e', "require('node:fs').writeFileSync('/data/sentinel','parallel owner preserved')");
      // Docker itself rejects removing a volume still used by the other owner.
      await expect(cleanupDockerTestResources(docker, label)).rejects.toThrow(`Docker test resources may remain for ${label}`);
      expect(await docker('ps', '-aq', '--filter', `label=${label}`)).toBe('');
      expect(await docker('volume', 'ls', '-q', '--filter', `label=${label}`)).toBe(volume);
      expect(await docker('network', 'inspect', '--format', '{{.Name}}', network)).toBe(network);
      expect(await docker('inspect', '--format', '{{.State.Running}}', peerContainer)).toBe('true');
      expect(await docker('exec', peerContainer, 'node', '-e', "console.log(require('node:fs').readFileSync('/data/sentinel','utf8'))")).toBe('parallel owner preserved');
      await cleanupDockerTestResources(docker, peerLabel);
      await cleanupDockerTestResources(docker, label);
      await cleanupDockerTestResources(docker, label); // Idempotent retry after completion.
      console.info('DOCKER_CLEANUP_ACCEPTANCE', JSON.stringify({ volumeAndNetworkInUseReported: true, parallelOwnerPreserved: true, retryAfterRelease: true }));
    } finally {
      const results = await Promise.allSettled([cleanupDockerTestResources(docker, peerLabel)]);
      results.push(...await Promise.allSettled([cleanupDockerTestResources(docker, label)]));
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) { throw new AggregateError(failures, `Inspect Docker test labels ${label} and ${peerLabel}`); }
    }
  }, 120_000);
});

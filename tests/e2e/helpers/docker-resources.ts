/** Only exact run labels are eligible; names/prefixes alone never authorize removal. */
export async function cleanupDockerTestResources(docker: (...args: string[]) => Promise<string>, label: string): Promise<void> {
  if (!/^io\.disclaude\.e2e-run=[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(label)) {
    throw new Error('A complete Docker test-run UUID label is required');
  }
  // A timed-out Docker CLI can leave a data-operation container running even
  // when the named service was never created. Include every run-owned container.
  const failures: unknown[] = [];
  try {
    const owned = (await docker('ps', '-aq', '--filter', `label=${label}`)).split(/\s+/u).filter(Boolean);
    for (const id of owned) {
      try { await docker('rm', '-f', id); }
      catch (error) { failures.push(new Error(`Could not remove owned container ${id}`, { cause: error })); }
    }
  } catch (error) { failures.push(new Error(`Could not enumerate owned containers for ${label}`, { cause: error })); }
  try {
    const owned = (await docker('volume', 'ls', '-q', '--filter', `label=${label}`)).split(/\s+/u).filter(Boolean);
    for (const name of owned) {
      try { await docker('volume', 'rm', name); }
      catch (error) { failures.push(new Error(`Could not remove owned volume ${name}`, { cause: error })); }
    }
  } catch (error) { failures.push(new Error(`Could not enumerate owned volumes for ${label}`, { cause: error })); }
  if (failures.length) {
    throw new AggregateError(failures, `Docker test resources may remain for ${label}; inspect this exact label before retrying cleanup`);
  }
  if (await docker('ps', '-aq', '--filter', `label=${label}`)
    || await docker('volume', 'ls', '-q', '--filter', `label=${label}`)) {
    throw new Error(`Docker test resources remain after cleanup for ${label}`);
  }
}

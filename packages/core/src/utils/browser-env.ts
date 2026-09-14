/** Keep transport discovery private to the coordinator in coordinated mode.
 * This is cooperative routing, not a same-user security boundary.
 * Call after all provider/task environment merges, immediately before spawning.
 */
export function browserAgentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!env.DISCLAUDE_BROWSER_SOCKET) {
    return env;
  }
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (
      key.startsWith('BU_CDP_') ||
      key.startsWith('CHROMIUM_CDP_') ||
      key.startsWith('DISCLAUDE_CHROMIUM_') ||
      [
        'BU_AUTOSPAWN',
        'BU_NAME',
        'BH_RUNTIME_DIR',
        'BH_TMP_DIR',
        'BH_RUNTIME_DIR_SHARED',
        'BH_TMP_DIR_SHARED',
        'BH_REQUIRE_EXISTING_DAEMON',
        'DISCLAUDE_BROWSER_TARGET',
        'DISCLAUDE_BROWSER_PYTHON',
        'DISCLAUDE_BROWSER_EVENTS',
        'DISCLAUDE_BROWSER_WORKSPACE',
      ].includes(key)
    ) {
      delete result[key];
    }
  }
  return result;
}

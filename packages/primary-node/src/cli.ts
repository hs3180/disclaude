#!/usr/bin/env node
/**
 * Primary Node CLI bootstrap.
 *
 * This file must stay free of imports from @disclaude/core. Config exposes
 * static fields that are initialized on first import, so the explicit
 * --config path has to be discovered before loading the real CLI module.
 *
 * @see https://github.com/hs3180/disclaude/issues/4654
 */

export const EXPLICIT_CONFIG_PATH_ENV = 'DISCLAUDE_CONFIG_PATH';

/** Return the last explicit --config/-c value, matching the CLI parser. */
export function findExplicitConfigPath(args: readonly string[]): string | undefined {
  let configPath: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== '--config' && args[index] !== '-c') {
      continue;
    }
    const value = args[index + 1];
    if (value && !value.startsWith('-')) {
      configPath = value;
      index++;
    }
  }
  return configPath;
}

type MainModule = { main(): Promise<void> };

export async function bootstrap(
  args = process.argv.slice(2),
  loadMain: () => Promise<MainModule> = () => import('./cli-main.js'),
): Promise<void> {
  const configPath = findExplicitConfigPath(args);
  if (configPath) {
    process.env[EXPLICIT_CONFIG_PATH_ENV] = configPath;
  }

  const { main } = await loadMain();
  await main();
}

if (process.argv[1]?.match(/cli\.[jt]s$/) || process.argv[1]?.includes('disclaude-primary')) {
  bootstrap().catch((error) => {
    console.error('Unhandled error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

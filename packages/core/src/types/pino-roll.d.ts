/**
 * Type declaration for pino-roll.
 *
 * Issue #3416: pino-roll is no longer used by the logger module.
 * The custom rotation mechanism in logger.ts replaced pino-roll to fix
 * a race condition where data could leak between files during rotation.
 *
 * This type declaration is kept for backward compatibility in case
 * other modules reference it. It can be removed in a future cleanup.
 */
declare module 'pino-roll' {
  import { SonicBoom } from 'sonic-boom';

  interface PinoRollOptions {
    file: string;
    size?: string | number;
    frequency?: string | number;
    extension?: string;
    limit?: { count?: number; removeOtherLogFiles?: boolean; };
    symlink?: boolean;
    dateFormat?: string;
    mkdir?: boolean;
  }

  function pinoRoll(options: PinoRollOptions): Promise<SonicBoom>;
  export default pinoRoll;
}

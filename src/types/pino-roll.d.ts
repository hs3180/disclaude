declare module 'pino-roll' {
  import { Transform } from 'stream';

  interface PinoRollOptions {
    /** Size limit for rotation (e.g., '10M', '100M') */
    size?: string;
    /** File limit configuration */
    limit?: {
      /** Maximum number of files to keep */
      count?: number;
      /** Maximum age of files */
      age?: string;
    };
    /** Compress rotated files with gzip */
    compress?: boolean;
    /** Date pattern for file naming */
    dateFormat?: string;
  }

  interface PinoRoll extends Transform {
    constructor: (...args: unknown[]) => PinoRoll;
  }

  interface PinoRollStatic {
    (file: string, options?: PinoRollOptions): PinoRoll;
  }

  const pinoRoll: PinoRollStatic;
  export default pinoRoll;
}

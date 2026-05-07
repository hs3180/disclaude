declare module 'pino-roll' {
  import { SonicBoom } from 'sonic-boom';

  interface PinoRollOptions {
    /** Path to the log file */
    file: string;
    /** Size limit for rotation (e.g., '10M', '100M') */
    size?: string | number;
    /** Frequency for rotation (e.g., 'daily', 'hourly', or ms) */
    frequency?: string | number;
    /** File extension to append after file number */
    extension?: string;
    /** File limit configuration */
    limit?: {
      /** Number of log files to keep (in addition to current) */
      count?: number;
      /** Whether to remove other matching log files */
      removeOtherLogFiles?: boolean;
    };
    /** Create symlink to current log file */
    symlink?: boolean;
    /** Date format for file naming (date-fns format) */
    dateFormat?: string;
    /** Create parent directory if it doesn't exist */
    mkdir?: boolean;
  }

  /**
   * Creates a SonicBoom stream for writing to rotated log files.
   * pino-roll v4 exports an async function taking a single options object.
   */
  function pinoRoll(options: PinoRollOptions): Promise<SonicBoom>;

  export default pinoRoll;
}

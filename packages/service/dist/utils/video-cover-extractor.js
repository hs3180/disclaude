/**
 * Video cover image extractor.
 *
 * Uses ffmpeg to extract the first frame of a video file as a JPEG cover image.
 * Required by Feishu's `msg_type: 'media'` for video messages — Feishu mandates
 * an `image_key` alongside the `file_key`.
 *
 * Issue #2265: Proper video support via msg_type:'media'.
 */
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { createLogger } from "../../../core/dist/index.js";
const logger = createLogger('VideoCoverExtractor');
/** Video file extensions that should use Feishu's media message type. */
export const VIDEO_EXTENSIONS = new Set([
    '.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv',
]);
/**
 * Check whether ffmpeg is available on the system PATH.
 *
 * Cached after first check to avoid repeated subprocess spawns.
 */
let _ffmpegAvailable;
/** Reset cached ffmpeg availability (for testing). */
export function _resetFfmpegCache() {
    _ffmpegAvailable = undefined;
}
export function isFfmpegAvailable() {
    if (_ffmpegAvailable !== undefined) {
        return _ffmpegAvailable;
    }
    try {
        const result = child_process.spawnSync('ffmpeg', ['-version'], {
            timeout: 5000,
            stdio: 'pipe',
        });
        _ffmpegAvailable = result.status === 0;
    }
    catch {
        _ffmpegAvailable = false;
    }
    return _ffmpegAvailable;
}
/**
 * Extract the first frame of a video file as a JPEG image.
 *
 * Uses `ffmpeg -i <input> -vframes 1 -f image2 <output>` to extract the frame.
 * The output JPEG is written to a temporary file.
 *
 * @param videoPath - Absolute path to the video file
 * @returns Result with cover image path on success, or error message on failure
 */
export function extractVideoCover(videoPath) {
    // Validate input
    if (!videoPath || !fs.existsSync(videoPath)) {
        return { success: false, error: `Video file not found: ${videoPath}` };
    }
    if (!isFfmpegAvailable()) {
        return { success: false, error: 'ffmpeg is not installed or not found in PATH' };
    }
    // Create temp output path for cover image
    const baseName = path.basename(videoPath, path.extname(videoPath));
    const coverPath = path.join(os.tmpdir(), `cover_${baseName}_${Date.now()}.jpg`);
    try {
        const result = child_process.spawnSync('ffmpeg', [
            '-i', videoPath,
            '-vframes', '1',
            '-f', 'image2',
            '-y', // overwrite output
            coverPath,
        ], {
            timeout: 30000, // 30 second timeout for cover extraction
            stdio: 'pipe',
        });
        if (result.status !== 0) {
            const stderr = result.stderr?.toString('utf-8') || 'unknown error';
            logger.warn({ videoPath, stderr: stderr.slice(-200) }, 'ffmpeg failed to extract cover frame');
            return { success: false, error: `ffmpeg exited with code ${result.status}: ${stderr.slice(-200)}` };
        }
        if (!fs.existsSync(coverPath) || fs.statSync(coverPath).size === 0) {
            return { success: false, error: 'ffmpeg produced no output file' };
        }
        logger.info({ videoPath, coverPath }, 'Video cover frame extracted');
        return { success: true, coverPath };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ videoPath, error: msg }, 'Failed to extract video cover');
        return { success: false, error: msg };
    }
}
/** Width of the placeholder cover PNG (16:9 aspect, matches typical video). */
const PLACEHOLDER_WIDTH = 480;
/** Height of the placeholder cover PNG. */
const PLACEHOLDER_HEIGHT = 270;
/** Solid fill color of the placeholder cover (dark gray, RGB). */
const PLACEHOLDER_RGB = [0x20, 0x21, 0x24];
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();
function crc32(buf) {
    let crc = 0xffffffff;
    for (const byte of buf) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
}
/**
 * Build a minimal solid-color PNG usable as a video cover.
 *
 * Pure Node (zlib only, no image libraries): Feishu's media message mandates
 * an `image_key`, so a syntactically valid PNG is enough to keep video
 * delivery working when a real frame cannot be extracted.
 */
function createPlaceholderCoverPng() {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(PLACEHOLDER_WIDTH, 0);
    ihdr.writeUInt32BE(PLACEHOLDER_HEIGHT, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type: truecolor RGB
    const row = Buffer.alloc(1 + PLACEHOLDER_WIDTH * 3); // leading filter byte 0
    const [r, g, b] = PLACEHOLDER_RGB;
    for (let x = 0; x < PLACEHOLDER_WIDTH; x++) {
        row[1 + x * 3] = r;
        row[2 + x * 3] = g;
        row[3 + x * 3] = b;
    }
    const raw = Buffer.concat(Array(PLACEHOLDER_HEIGHT).fill(row));
    return Buffer.concat([
        signature,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}
/**
 * Write a placeholder cover image for a video, without requiring ffmpeg.
 *
 * Issue #5391: on hosts without ffmpeg, cover extraction fails and the old
 * fallback sent the video via `msg_type:'file'`, which Feishu rejects for
 * video files (230055). A locally generated placeholder keeps the media
 * message path usable so the video still delivers.
 *
 * @param videoPath - Path of the video (used only for the temp file name)
 * @returns Result with placeholder cover path on success
 */
export function writePlaceholderCover(videoPath) {
    if (!videoPath) {
        return { success: false, error: 'Video path is required for placeholder cover' };
    }
    try {
        const baseName = path.basename(videoPath, path.extname(videoPath));
        const coverPath = path.join(os.tmpdir(), `cover_${baseName}_${Date.now()}.png`);
        fs.writeFileSync(coverPath, createPlaceholderCoverPng());
        logger.info({ coverPath }, 'Placeholder video cover written (no extracted frame available)');
        return { success: true, coverPath };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ error: msg }, 'Failed to write placeholder video cover');
        return { success: false, error: msg };
    }
}

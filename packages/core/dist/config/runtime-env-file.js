import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const MAX_BYTES = 64 * 1024;
/** Workspace must be a trusted directory. Never follow a credential-file link. */
export function readRuntimeFile(filePath) {
    let fd;
    try {
        // NONBLOCK also prevents a malicious FIFO from blocking the service.
        fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) {
            throw new Error('Unsafe runtime environment file');
        }
        if (process.platform !== 'win32') {
            fs.fchmodSync(fd, 0o600);
        }
        return fs.readFileSync(fd, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return '';
        }
        throw new Error('Cannot safely read runtime environment file');
    }
    finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
        }
    }
}
/** Atomic replacement: readers see the previous or the complete new value. */
export function writeRuntimeFile(filePath, content) {
    if (Buffer.byteLength(content) > MAX_BYTES) {
        throw new Error('Runtime environment file is too large');
    }
    readRuntimeFile(filePath);
    const temporary = path.join(path.dirname(filePath), `.runtime-env-${randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, content, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporary, filePath);
    }
    catch {
        throw new Error('Cannot safely write runtime environment file');
    }
    finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
        }
        fs.rmSync(temporary, { force: true });
    }
}

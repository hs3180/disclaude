/**
 * Lossless, bounded Markdown round retention (S06-A4, #4810).
 * node /path/to/disclaude/scripts/compact-loop-ledger.mjs --file /path/STATE.md
 * Add --apply after inspecting the default dry-run; --keep-rounds 5 --max-bytes 12288.
 * Permanent state/constraints precede the first `## Round N` or `## 第 N 轮`.
 * Everything after each marker belongs to that round; use ### for subsections.
 * Archives are written before the active file is atomically replaced. A lock
 * excludes other compactors; writers must honor <file>.compact.lock as well.
 * Interrupted archive writes can be retried; no archive is overwritten.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function positive(value, name) {
  if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}
const args = process.argv.slice(2);
let file;
let apply = false;
let mode;
let keep = 5;
let maxBytes = 12288;
try {
  while (args.length) {
    const option = args.shift();
    if (option === '--file') file = args.shift();
    else if (option === '--keep-rounds') keep = positive(args.shift(), option);
    else if (option === '--max-bytes') maxBytes = positive(args.shift(), option);
    else if (['--apply', '--dry-run'].includes(option)) {
      if (mode && mode !== option) throw new Error('--apply and --dry-run are mutually exclusive');
      mode = option;
      apply = option === '--apply';
    } else throw new Error(`Unknown argument: ${option}`);
  }
  if (!file) throw new Error('Required: --file <ledger>; default is a read-only dry-run');
  file = path.resolve(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Ledger must be a regular, non-symlink file');
  const original = fs.readFileSync(file, 'utf8');
  const markers = [];
  let offset = 0;
  let fence;
  for (const line of original.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (delimiter && !fence) fence = delimiter[1];
    else if (fence && new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line.trimEnd())) fence = undefined;
    else if (!fence) {
      const marker = line.match(/^## (?:Round (\d+)|第\s*(\d+)\s*轮)(?:\s.*)?\r?\n?$/);
      if (marker) markers.push({ number: positive(marker[1] ?? marker[2], 'round'), offset });
      else if (markers.length && /^#{1,2}\s/.test(line)) throw new Error('Permanent headings must precede round markers; use ### within rounds');
    }
    offset += line.length;
  }
  if (!markers.length) throw new Error('No supported round markers; migrate headings before compaction');
  if (markers.some((marker, index) => index > 0 && marker.number <= markers[index - 1].number)) throw new Error('Round numbers must be unique and increasing');
  const prefix = original.slice(0, markers[0].offset);
  const blocks = markers.map((marker, index) => ({ ...marker, text: original.slice(marker.offset, markers[index + 1]?.offset) }));
  let cut = Math.max(0, blocks.length - keep);
  const render = () => prefix + blocks.slice(cut).map(block => block.text).join('');
  while (Buffer.byteLength(render()) > maxBytes && cut < blocks.length - 1) cut++;
  const next = render();
  if (Buffer.byteLength(next) > maxBytes) throw new Error('Permanent state plus newest round exceeds byte budget; summarize current state explicitly before retrying');
  const archiveDir = file + '.archive';
  const moves = blocks.slice(0, cut).map(block => ({
    ...block,
    archive: path.join(archiveDir, `round-${String(block.number).padStart(8, '0')}-${crypto.createHash('sha256').update(block.text).digest('hex')}.md`),
  }));
  // Validate existing archives even in dry-run; never overwrite mismatched bytes.
  for (const move of moves) if (fs.existsSync(move.archive) && fs.readFileSync(move.archive, 'utf8') !== move.text) throw new Error('Existing archive content mismatch: ' + move.archive);
  if (apply && moves.length) {
    const lock = file + '.compact.lock';
    const lockFd = fs.openSync(lock, 'wx', 0o600);
    let temporary;
    try {
      if (fs.readFileSync(file, 'utf8') !== original || fs.lstatSync(file).isSymbolicLink()) throw new Error('Ledger changed during planning; retry');
      if (fs.existsSync(archiveDir) && fs.lstatSync(archiveDir).isSymbolicLink()) throw new Error('Archive directory must not be a symlink');
      fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
      for (const move of moves) {
        if (!fs.existsSync(move.archive)) {
          const pending = move.archive + '.' + crypto.randomUUID() + '.tmp';
          try {
            const fd = fs.openSync(pending, 'wx', 0o600);
            try { fs.writeFileSync(fd, move.text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            fs.linkSync(pending, move.archive);
          } finally { if (fs.existsSync(pending)) fs.unlinkSync(pending); }
        }
        if (fs.lstatSync(move.archive).isSymbolicLink() || fs.readFileSync(move.archive, 'utf8') !== move.text) throw new Error('Archive verification failed: ' + move.archive);
      }
      temporary = file + '.' + crypto.randomUUID() + '.tmp';
      const fd = fs.openSync(temporary, 'wx', stat.mode & 0o777);
      try { fs.writeFileSync(fd, next); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (fs.readFileSync(file, 'utf8') !== original) throw new Error('Ledger writer ignored compaction lock; active file left unchanged');
      fs.renameSync(temporary, file);
      temporary = undefined;
    } finally {
      if (temporary) fs.unlinkSync(temporary);
      fs.closeSync(lockFd);
      fs.unlinkSync(lock);
    }
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', file, beforeBytes: Buffer.byteLength(original), afterBytes: Buffer.byteLength(next), keptRounds: blocks.slice(cut).map(x => x.number), archivedRounds: moves.map(x => x.number), archiveDir }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

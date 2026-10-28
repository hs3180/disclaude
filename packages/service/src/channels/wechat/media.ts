import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { IncomingMessage } from '@disclaude/core';
import type { WeChatImageItem, WeChatFileItem, WeChatUploadedMedia } from './types.js';
import { WeChatMediaError } from './media-error.js';

/** Adapter policy, not a claim about the gateway's maximum. */
export const WECHAT_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';

function cdnUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid WeChat media URL'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') || url.username || url.password || url.port) {
    throw new Error('Unsupported WeChat media host');
  }
  return url.href;
}

function mediaSignal(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/** Current iLink upload: negotiate -> encrypted CDN POST -> reusable media ref. */
export async function uploadEncryptedMedia(params: {
  fileData: Buffer;
  to: string;
  kind: 'image' | 'file' | 'video';
  requestUpload: (body: Record<string, unknown>) => Promise<{ upload_param?: string; upload_full_url?: string }>;
}): Promise<WeChatUploadedMedia> {
  if (params.fileData.length > WECHAT_MEDIA_MAX_BYTES) { throw new Error('File too large: WeChat adapter limit is 20 MiB'); }
  const key = randomBytes(16);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(params.fileData), cipher.final()]);
  const filekey = randomBytes(16).toString('hex');
  const spec = await params.requestUpload({
    filekey, to_user_id: params.to, media_type: params.kind === 'image' ? 1 : params.kind === 'video' ? 2 : 3,
    rawsize: params.fileData.length, rawfilemd5: createHash('md5').update(params.fileData).digest('hex'),
    filesize: encrypted.length, no_need_thumb: true, aeskey: key.toString('hex'),
  });
  if (!spec.upload_full_url && !spec.upload_param) { throw new Error('WeChat upload response missing upload URL'); }
  const url = cdnUrl(spec.upload_full_url || `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(spec.upload_param ?? '')}&filekey=${filekey}`);
  let response: Response;
  try { response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(encrypted), signal: mediaSignal(), redirect: 'error' }); }
  catch { throw new Error('WeChat CDN upload failed or timed out; message was not sent'); }
  const downloadParam = response.headers.get('x-encrypted-param');
  await response.body?.cancel();
  if (!response.ok) { throw new Error(`WeChat CDN upload failed [${response.status}]; message was not sent`); }
  if (!downloadParam) { throw new Error('WeChat CDN upload missing download reference; message was not sent'); }
  return { media: { encrypt_query_param: downloadParam, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 }, size: params.fileData.length, encryptedSize: encrypted.length };
}

function aesKey(encoded: string): Buffer {
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length === 16) { return decoded; }
  if (decoded.length === 32 && /^[a-f\d]{32}$/i.test(decoded.toString())) { return Buffer.from(decoded.toString(), 'hex'); }
  throw new Error('Invalid WeChat media encryption key');
}

/** Keep the private attachment cache bounded: 7 days, 200 files, 256 MiB. */
async function pruneMedia(dir: string): Promise<void> {
  const entries = await Promise.all((await fs.readdir(dir)).map(async name => ({ name, stat: await fs.lstat(join(dir, name)) })));
  let bytes = 0; let count = 0;
  for (const entry of entries.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)) {
    if (!entry.stat.isFile()) { continue; }
    bytes += entry.stat.size; count++;
    if (count > 200 || bytes > 256 * 1024 * 1024 || entry.stat.mtimeMs < Date.now() - 7 * 86_400_000) { await fs.rm(join(dir, entry.name), { force: true }); }
  }
}

/** Download/decrypt into the common channel's local attachment abstraction. */
export async function downloadWeChatMedia(item: WeChatImageItem | WeChatFileItem, dir: string, signal?: AbortSignal): Promise<NonNullable<IncomingMessage['attachments']>[number]> {
  const started = Date.now();
  let stage: 'reference' | 'fetch' | 'read' | 'decrypt' | 'write' = 'reference';
  let size = 0;
  const failure = (reason: ConstructorParameters<typeof WeChatMediaError>[0]['reason'], httpStatus?: number, error?: unknown) =>
    new WeChatMediaError({ stage, reason, elapsedMs: Date.now() - started, bytes: size, httpStatus }, error);
  try {
    const payload = item.type === 2 ? item.image_item : item.file_item;
    const { media } = payload;
    const source = media?.full_url || (media?.encrypt_query_param ? `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}` : payload.url);
    if (!source) { throw failure('reference'); }
    const url = cdnUrl(source);
    stage = 'fetch';
    const response = await fetch(url, { signal: mediaSignal(signal), redirect: 'error' });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > WECHAT_MEDIA_MAX_BYTES + 16) {
      await response.body?.cancel();
      throw failure(response.ok ? 'size' : 'http', response.status);
    }
    stage = 'read';
    const reader = response.body?.getReader();
    if (!reader) { throw failure('empty'); }
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) { break; }
        size += chunk.value.length;
        if (size > WECHAT_MEDIA_MAX_BYTES + 16) { throw failure('size'); }
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let data = Buffer.concat(chunks);
    stage = 'decrypt';
    const imageKey = item.type === 2 ? item.image_item.aeskey : undefined;
    const encodedKey = imageKey ? Buffer.from(imageKey, 'hex').toString('base64') : media?.aes_key;
    if (encodedKey) {
      let key: Buffer;
      try { key = aesKey(encodedKey); } catch (error) { throw failure('key', undefined, error); }
      try { const decipher = createDecipheriv('aes-128-ecb', key, null); data = Buffer.concat([decipher.update(data), decipher.final()]); }
      catch (error) { throw failure('decrypt', undefined, error); }
    } else if (media?.encrypt_query_param || media?.encrypt_type) { throw failure('key'); }
    if (data.length > WECHAT_MEDIA_MAX_BYTES) { throw failure('size'); }
    const imageMime = data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png' : data[0] === 0xff && data[1] === 0xd8 ? 'image/jpeg' : undefined;
    const original = item.type === 4 ? item.file_item.file_name ?? 'file.bin' : `image.${imageMime === 'image/png' ? 'png' : imageMime === 'image/jpeg' ? 'jpg' : 'bin'}`;
    const fileName = basename(original.replaceAll('\\', '/')).replace(/[\x00-\x1f]/g, '_').slice(-180) || 'file.bin';
    stage = 'write';
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(dir)).isDirectory()) { throw new Error('Invalid WeChat attachment directory'); }
    await fs.chmod(dir, 0o700);
    const filePath = join(dir, `${randomUUID()}-${fileName}`);
    await fs.writeFile(filePath, data, { flag: 'wx', mode: 0o600 });
    await pruneMedia(dir);
    return { fileName, filePath, size: data.length, mimeType: item.type === 2 ? imageMime : undefined };
  } catch (error) {
    if (error instanceof WeChatMediaError) { throw error; }
    throw failure(signal?.aborted ? 'cancelled' : stage === 'reference' ? 'host' : stage === 'decrypt' ? 'decrypt' : stage === 'write' ? 'write' : 'network', undefined, error);
  }
}

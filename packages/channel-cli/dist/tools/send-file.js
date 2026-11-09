/**
 * send_file tool implementation.
 *
 * Issue #1619: Added parentMessageId (threadId) parameter for thread reply support.
 *
 * @module channel-cli/tools/send-file
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { Config, createLogger, uploadFile } from "../../../core/dist/index.js";
import { isChannelApiAvailable, getChannelApiClient, buildChannelApiFallbackHint } from './channel-api-utils.js';
import { resolveDeliveryPosition } from './delivery-position.js';
const logger = createLogger('SendFile');
/**
 * Upload file via REST API to DisclaudeService's LarkClientService.
 * Issue #1035: Routes Feishu API calls through unified client.
 * Issue #1619: Added threadId parameter for thread reply support.
 * Issue #2300: Propagate REST API error details for better diagnostics.
 * Issue #5630: Passes the retry-dedup idempotency key through to the service.
 */
async function uploadFileViaChannelApi(chatId, filePath, threadId, idempotencyKey) {
    // Issue #4280 (Phase 3, part 3): REST-only — direct ChannelApiClient.
    const apiClient = getChannelApiClient();
    return await uploadFile(apiClient, chatId, filePath, threadId, { idempotencyKey });
}
export async function send_file(params) {
    const { filePath, chatId, parentMessageId, onProgress } = params;
    try {
        if (!chatId) {
            throw new Error('chatId is required');
        }
        const workspaceDir = Config.getWorkspaceDir();
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);
        logger.debug({ filePath, resolvedPath, chatId, hasParent: !!parentMessageId }, 'send_file called');
        const stats = await fs.stat(resolvedPath);
        if (!stats.isFile()) {
            throw new Error(`Path is not a file: ${filePath}`);
        }
        // Issue #1035: Try REST API first if available
        // Issue #1042: Removed file-transfer fallback, require REST API
        // Issue #1355: async connection probe
        const useChannelApi = await isChannelApiAvailable();
        if (!useChannelApi) {
            return {
                success: false,
                error: 'REST API not available',
                // Issue #4576: actionable fallback — +messages-send loses thread
                // attribution in topic groups; +messages-reply preserves it.
                // filePath (the original arg, not the workspace-resolved absolute
                // path) rides along so the suggested reply command carries --file —
                // +messages-reply requires a content flag or the reply is empty.
                message: `❌ File upload requires REST API connection. Please ensure disclaude service is running.${buildChannelApiFallbackHint(parentMessageId, { filePath })}`,
            };
        }
        logger.debug({ chatId, filePath, parentMessageId }, 'Using REST API for file upload');
        // Issue #4568: the upload is one long-silent REST request; report the
        // size (already known from stat) right before it starts so the tool is
        // not misjudged as stalled while the bytes transfer.
        if (typeof onProgress === 'function') {
            const sizeMBBefore = (stats.size / 1024 / 1024).toFixed(2);
            onProgress({ message: `Uploading ${path.basename(resolvedPath)} (${sizeMBBefore} MB)…` });
        }
        // Issue #5630: a stable key per logical send lets a post-timeout retry
        // dedupe at the service instead of double-delivering.
        const idempotencyKey = params.idempotencyKey?.trim() || `send-file-${randomUUID()}`;
        const fileName = path.basename(resolvedPath);
        const result = await uploadFileViaChannelApi(chatId, resolvedPath, parentMessageId, idempotencyKey);
        if (result.outcomeUnknown) {
            // Issue #5630: the deadline expired mid-chain, NOT a confirmed failure —
            // the service may still complete the upload and deliver the file.
            logger.warn({ filePath: resolvedPath, chatId, idempotencyKey }, 'send_file deadline reached; delivery outcome unknown');
            return {
                success: false,
                error: result.error,
                outcomeUnknown: true,
                idempotencyKey,
                message: `⏱️ Upload timed out — delivery outcome UNKNOWN: the disclaude service may still be sending ${fileName}, so it may still arrive in the chat. Do NOT blindly resend.` +
                    ` To retry safely, call send_file again with idempotencyKey "${idempotencyKey}" — the service replays the remembered outcome instead of re-sending.` +
                    ' Alternatively, check the chat first to see whether the file already arrived.',
            };
        }
        if (!result.success) {
            const errorDetail = result.error ? `: ${result.error}` : '';
            throw new Error(`Failed to upload file via REST API${errorDetail}`);
        }
        const fileSize = result.fileSize ?? 0;
        const sizeMB = (fileSize / 1024 / 1024).toFixed(2);
        // Issue #5722: echo the actual delivery position. Without this, a send_file
        // missing --parent in a topic group silently started a NEW topic while the
        // success message stayed byte-identical to an in-topic reply. Prefer the
        // server-confirmed position from the REST response; derive from the --parent
        // request when the service does not report one.
        const delivery = resolveDeliveryPosition({
            parentMessageId,
            deliveryPosition: result.deliveryPosition,
            threadId: result.threadId,
            messageId: result.messageId,
        });
        if (delivery.parentOmitted) {
            logger.warn({ filePath: resolvedPath, chatId, messageId: result.messageId }, 'send_file without --parent: in a topic group the file starts a NEW topic instead of landing in the current one');
        }
        logger.info({ fileName, fileSize, chatId, deliveryPosition: delivery.deliveryPosition, threadId: delivery.threadId, messageId: result.messageId }, 'File sent successfully');
        return {
            success: true,
            message: `✅ File sent: ${fileName} (${sizeMB} MB) ${delivery.suffix}`,
            fileName,
            fileSize,
            sizeMB,
            deliveryPosition: delivery.deliveryPosition,
            ...(delivery.threadId ? { parentMessageId: delivery.threadId } : {}),
            ...(result.messageId ? { messageId: result.messageId } : {}),
        };
    }
    catch (error) {
        let platformCode;
        let platformMsg;
        let platformLogId;
        let troubleshooterUrl;
        if (error && typeof error === 'object') {
            const err = error;
            if (err.response?.data && Array.isArray(err.response.data) && err.response.data[0]) {
                platformCode = err.response.data[0].code;
                platformMsg = err.response.data[0].msg;
                platformLogId = err.response.data[0].log_id;
                troubleshooterUrl = err.response.data[0].troubleshooter;
            }
            if (!platformCode && typeof err.code === 'number') {
                platformCode = err.code;
            }
            if (!platformMsg) {
                platformMsg = err.msg || err.message;
            }
        }
        logger.error({ err: error, filePath, chatId, platformCode, platformMsg }, 'send_file failed');
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        let errorDetails = `❌ Failed to send file: ${errorMessage}`;
        if (platformCode) {
            errorDetails += `\n\n**Platform API Error:** Code: ${platformCode}`;
            if (platformMsg) {
                errorDetails += `, Message: ${platformMsg}`;
            }
        }
        return {
            success: false,
            error: errorMessage,
            message: errorDetails,
            platformCode,
            platformMsg,
            platformLogId,
            troubleshooterUrl,
        };
    }
}

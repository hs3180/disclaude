/**
 * send_file tool implementation.
 *
 * Issue #1619: Added parentMessageId (threadId) parameter for thread reply support.
 *
 * @module channel-cli/tools/send-file
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { Config, createLogger, uploadFile } from "../../../core/dist/index.js";
import { isChannelApiAvailable, getChannelApiClient, buildChannelApiFallbackHint } from './channel-api-utils.js';
const logger = createLogger('SendFile');
/**
 * Upload file via REST API to DisclaudeService's LarkClientService.
 * Issue #1035: Routes Feishu API calls through unified client.
 * Issue #1619: Added threadId parameter for thread reply support.
 * Issue #2300: Propagate REST API error details for better diagnostics.
 */
async function uploadFileViaChannelApi(chatId, filePath, threadId) {
    // Issue #4280 (Phase 3, part 3): REST-only — direct ChannelApiClient.
    const apiClient = getChannelApiClient();
    const result = await uploadFile(apiClient, chatId, filePath, threadId);
    if (!result.success) {
        const errorDetail = result.error ? `: ${result.error}` : '';
        throw new Error(`Failed to upload file via REST API${errorDetail}`);
    }
    return {
        fileKey: result.fileKey ?? '',
        fileType: result.fileType ?? 'file',
        fileName: result.fileName ?? path.basename(filePath),
        fileSize: result.fileSize ?? 0,
    };
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
        const { fileSize } = await uploadFileViaChannelApi(chatId, resolvedPath, parentMessageId);
        const sizeMB = (fileSize / 1024 / 1024).toFixed(2);
        const fileName = path.basename(resolvedPath);
        logger.info({ fileName, fileSize, chatId, threadReply: !!parentMessageId }, 'File sent successfully');
        return {
            success: true,
            message: `✅ File sent: ${fileName} (${sizeMB} MB)`,
            fileName,
            fileSize,
            sizeMB,
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

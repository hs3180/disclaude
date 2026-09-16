import { createHash } from 'node:crypto';
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => { throw new Error('关联文档未同步：请检查访问权限、文档大小或并发修改后恢复。已有成果保留。'); };
export function documentToken(url) {
    if (!url.trim()) {
        return undefined;
    }
    try {
        const parsed = new URL(url);
        const token = /^\/docx\/([A-Za-z0-9]+)\/?$/u.exec(parsed.pathname)?.[1];
        if (parsed.protocol === 'https:' && token && token.length <= 100) {
            return token;
        }
    }
    catch { /* Report a user-facing unsupported reference instead of fetching arbitrary URLs. */ }
    throw new Error('请填写新版飞书文档的 HTTPS /docx/ 链接；Wiki 和非文本附件暂不支持。');
}
/** Complete text/comment pagination; never substitute empty feedback after a failed read. */
export function createDocumentReader(client) {
    return async (token, publishedFragments = []) => {
        const before = await client.docx.document.get({ path: { document_id: token } });
        const revision = before.data?.document?.revision_id;
        if (before.code !== 0 || !Number.isSafeInteger(revision)) {
            return fail();
        }
        const raw = await client.docx.document.rawContent({ path: { document_id: token } });
        if (raw.code !== 0 || typeof raw.data?.content !== 'string' || raw.data.content.length > 256_000) {
            return fail();
        }
        const comments = [];
        const pages = new Set();
        let pageToken;
        do {
            const response = await client.drive.fileComment.list({ path: { file_token: token }, params: { file_type: 'docx', page_size: 50, page_token: pageToken, user_id_type: 'open_id' } });
            if (response.code !== 0 || !response.data || !Array.isArray(response.data.items)) {
                return fail();
            }
            for (const comment of response.data.items) {
                if (!comment.comment_id) {
                    return fail();
                }
                const replies = [...(comment.reply_list?.replies ?? [])];
                let moreReplies = comment.has_more;
                let replyToken = comment.page_token;
                const replyPages = new Set();
                while (moreReplies) {
                    if (!replyToken || replyPages.has(replyToken) || replyPages.size >= 20) {
                        return fail();
                    }
                    replyPages.add(replyToken);
                    const page = await client.drive.fileCommentReply.list({
                        path: { file_token: token, comment_id: comment.comment_id },
                        params: { file_type: 'docx', page_size: 50, page_token: replyToken, user_id_type: 'open_id' },
                    });
                    if (page.code !== 0 || !page.data || !Array.isArray(page.data.items)) {
                        return fail();
                    }
                    replies.push(...page.data.items);
                    moreReplies = page.data.has_more;
                    replyToken = page.data.page_token;
                }
                if (!replies.length) {
                    return fail();
                }
                for (const reply of replies) {
                    if (!reply.reply_id || reply.extra?.image_list?.length) {
                        return fail();
                    }
                    const body = reply.content.elements.map(element => element.type === 'text_run' ? element.text_run?.text
                        : element.type === 'docs_link' ? element.docs_link?.url : element.person?.user_id).join('');
                    const text = `${comment.is_solved ? '已解决评论' : '评论'}${comment.quote ? `（引用：${comment.quote}）` : ''}\n${body}`;
                    if (text.length > 3000 || comments.length >= 200) {
                        return fail();
                    }
                    comments.push({ id: `${comment.comment_id}/${reply.reply_id}`, text });
                }
            }
            if (!response.data.has_more) {
                break;
            }
            pageToken = response.data.page_token;
            if (!pageToken || pages.has(pageToken)) {
                return fail();
            }
            pages.add(pageToken);
            if (pages.size > 20) {
                return fail();
            }
        } while (true);
        if (new Set(comments.map(c => c.id)).size !== comments.length) {
            return fail();
        }
        const after = await client.docx.document.get({ path: { document_id: token } });
        if (after.code !== 0 || after.data?.document?.revision_id !== revision) {
            return fail();
        }
        comments.sort((a, b) => a.id.localeCompare(b.id));
        let body = raw.data.content;
        // Only an exact, unique published fragment is excluded from new source
        // material. User edits or duplicates remain visible as changed material.
        for (const fragment of publishedFragments) {
            const start = body.indexOf(fragment);
            const end = start + fragment.length;
            if (start >= 0 && body.indexOf(fragment, end) < 0 && (start === 0 || body[start - 1] === '\n')
                && (end === body.length || body[end] === '\n')) {
                body = body.slice(0, start) + body.slice(end + (body[end] === '\n' ? 1 : 0));
            }
        }
        if (body.length > 48_000 || JSON.stringify({ body, comments }).length > 64_000) {
            return fail();
        }
        return { token, revision: revision, body, rawBody: raw.data.content, comments,
            fingerprint: fingerprint({ body, comments }), syncedAt: new Date().toISOString() };
    };
}
/** Append only: no existing block is edited or deleted, even on a stale base. */
export function createDocumentAppender(client) {
    return async (token, operation) => {
        const result = await client.docx.documentBlockChildren.create({ path: { document_id: token, block_id: token },
            params: { document_revision_id: operation.revision, client_token: operation.id },
            data: { index: -1, children: operation.paragraphs.map(content => ({ block_type: 2, text: { elements: content.split('\n').flatMap((line, index) => [
                            ...(index ? [{ text_run: { content: '\n' } }] : []),
                            { text_run: { content: line, ...(/^https?:\/\/\S+$/u.test(line) ? { text_element_style: { link: { url: line } } } : {}) } },
                        ]) } })) } });
        if (result.code !== 0 || result.data?.children?.length !== operation.paragraphs.length) {
            throw new Error('Document append could not be confirmed');
        }
    };
}
export function changedDocumentFeedback(previous, next) {
    const feedback = [];
    if (previous?.body !== next.body) {
        feedback.push({ key: `body:${fingerprint(next.body)}`, text: '关联文档正文已更新。请根据最新完整正文核对任务范围、材料和用户修订，并记录意见处理及实际工作变化。' });
    }
    for (const comment of next.comments) {
        if (previous?.comments.find(c => c.id === comment.id)?.text !== comment.text) {
            feedback.push({ key: `comment:${comment.id}:${fingerprint(comment.text)}`, text: comment.text });
        }
    }
    for (const comment of previous?.comments ?? []) {
        if (!next.comments.some(c => c.id === comment.id)) {
            feedback.push({ key: `removed:${comment.id}:${next.fingerprint}`, text: `此前评论已删除，请核对其对结论的影响，不自动撤销或重复执行旧意见：\n${comment.text}` });
        }
    }
    return feedback;
}

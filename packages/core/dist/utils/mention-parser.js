/**
 * Mention Parser - Parse @mentions from Feishu messages.
 *
 * Issue #689: 正确处理消息中的 mention
 *
 * Feishu message mentions structure:
 * - mentions array contains information about @mentioned users
 * - text contains placeholders like `<at user_id="xxx">@用户</at>`
 *
 * This module provides:
 * - Parse mentions array to extract open_id list
 * - Replace placeholders with actual @mention format
 * - Check if message is mentioning a specific user
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/intro
 */
/**
 * Parse mentions from a Feishu message.
 *
 * @param mentions - Mentions array from Feishu message (can be undefined/null)
 * @returns Array of parsed mention information
 */
export function parseMentions(mentions) {
    if (!mentions || mentions.length === 0) {
        return [];
    }
    const result = [];
    for (const mention of mentions) {
        if (!mention?.id?.open_id) {
            continue;
        }
        result.push({
            openId: mention.id.open_id,
            unionId: mention.id.union_id,
            userId: mention.id.user_id,
            name: mention.name,
            key: mention.key,
        });
    }
    return result;
}
/**
 * Check if a specific user is mentioned in the message.
 *
 * @param mentions - Mentions array from Feishu message
 * @param userOpenId - The open_id to check for
 * @returns true if the user is mentioned
 */
export function isUserMentioned(mentions, userOpenId) {
    if (!mentions || mentions.length === 0) {
        return false;
    }
    return mentions.some((mention) => {
        if (!mention?.id) {
            return false;
        }
        return (mention.id.open_id === userOpenId ||
            mention.id.union_id === userOpenId ||
            mention.id.user_id === userOpenId);
    });
}
/**
 * Extract all mentioned open_ids from a message.
 *
 * @param mentions - Mentions array from Feishu message
 * @returns Array of open_ids that were mentioned
 */
export function extractMentionedOpenIds(mentions) {
    if (!mentions || mentions.length === 0) {
        return [];
    }
    return mentions
        .filter((mention) => mention?.id?.open_id)
        .map((mention) => mention.id.open_id);
}
/**
 * Normalize mention placeholders in text.
 *
 * Feishu may send text with different placeholder formats:
 * - `<at user_id="xxx">@Name</at>` - normalized format
 * - `${key}` - placeholder format (key is from mentions array)
 *
 * This function normalizes all formats to: @DisplayName
 *
 * @param text - Text content with placeholders
 * @param mentions - Mentions array from Feishu message
 * @returns Text with normalized @mentions
 */
export function normalizeMentionPlaceholders(text, mentions) {
    if (!mentions || mentions.length === 0) {
        return text;
    }
    let result = text;
    // Build a map of key -> name for replacement
    const keyToName = new Map();
    for (const mention of mentions) {
        if (mention.key && mention.name) {
            keyToName.set(mention.key, mention.name);
        }
    }
    // Replace placeholder patterns
    // Pattern 1: <at user_id="xxx">@Name</at> - already normalized, keep as is
    // Pattern 2: ${key} - replace with @Name
    for (const [key, name] of keyToName) {
        const placeholderPattern = new RegExp(`\\$\\{${escapeRegExp(key)}\\}`, 'g');
        result = result.replace(placeholderPattern, `@${name}`);
    }
    return result;
}
/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Strip leading mentions from text.
 *
 * This is used to detect commands in messages that start with @mentions.
 * For example: "@bot /help" should be recognized as a command "/help".
 *
 * Handles multiple mention formats:
 * - `<at user_id="xxx">@Name</at>` - normalized format
 * - `${key}` - placeholder format (key is from mentions array)
 * - `@Name` - simple @mention format
 *
 * Issue #698: Commands should be detected after stripping leading mentions
 *
 * @param text - Text content with potential leading mentions
 * @param mentions - Mentions array from Feishu message
 * @returns Text with leading mentions stripped
 */
export function stripLeadingMentions(text, mentions) {
    if (!text) {
        return text;
    }
    let result = text.trim();
    // Build a map of key -> name for placeholder replacement
    const keyToName = new Map();
    if (mentions) {
        for (const mention of mentions) {
            if (mention.key && mention.name) {
                keyToName.set(mention.key, mention.name);
            }
        }
    }
    // Keep stripping leading mentions until no more are found
    let changed = true;
    while (changed) {
        changed = false;
        // Pattern 1: <at user_id="xxx">@Name</at> at the start
        const atTagMatch = result.match(/^<at[^>]*>@[^<]+<\/at>\s*/i);
        if (atTagMatch) {
            result = result.slice(atTagMatch[0].length).trim();
            changed = true;
            continue;
        }
        // Pattern 2: ${key} at the start (placeholder format)
        if (keyToName.size > 0) {
            for (const [key] of keyToName) {
                const placeholderPattern = new RegExp(`^\\$\\{${escapeRegExp(key)}\\}\\s*`);
                if (placeholderPattern.test(result)) {
                    result = result.replace(placeholderPattern, '').trim();
                    changed = true;
                    break;
                }
            }
            if (changed) {
                continue;
            }
        }
        // Pattern 3: @Name at the start (simple format)
        // Match @ followed by non-whitespace characters
        const simpleMentionMatch = result.match(/^@[^\s]+\s*/);
        if (simpleMentionMatch) {
            result = result.slice(simpleMentionMatch[0].length).trim();
            changed = true;
        }
    }
    return result;
}

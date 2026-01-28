/**
 * Feishu message content builder utilities.
 * Provides consistent message formatting for different Feishu message types.
 *
 * Feishu API expects the `content` field to be a JSON string.
 * This utility encapsulates the JSON.stringify() logic and provides
 * type-safe content builders for different message types.
 *
 * Reference: https://open.feishu.cn/document/server-docs/im-v1/message/create
 */

/**
 * Post (rich text) element types.
 * Post content supports rich formatting with multiple element types.
 */
export interface PostTextElement {
  tag: 'text';
  text: string;
}

export interface PostAtElement {
  tag: 'at';
  user_id: string;
  text?: string;
}

export interface PostLinkElement {
  tag: 'a';
  text: string;
  href: string;
}

export interface PostImageElement {
  tag: 'img';
  image_key: string;
}

export type PostElement = PostTextElement | PostAtElement | PostLinkElement | PostImageElement;

/**
 * Post content structure for rich text messages.
 * The content field should have zh_cn as the top-level key.
 * {
 *   zh_cn: {
 *     title?: string;
 *     content: [[PostElement, ...], ...]
 *   }
 * }
 */
export interface PostContent {
  zh_cn: {
    title?: string;
    content: PostElement[][];
  };
}

/**
 * Build text message content.
 * Text messages are simple plain text.
 *
 * @param text - Plain text content
 * @returns JSON string suitable for Feishu API content field
 *
 * @example
 * const content = buildTextContent('Hello, world!');
 * // Returns: '{"text":"Hello, world!"}'
 */
export function buildTextContent(text: string): string {
  return JSON.stringify({ text });
}

/**
 * Build post (rich text) message content.
 * Post messages support rich formatting with multiple element types.
 *
 * IMPORTANT: The top-level key in content must be 'zh_cn', not 'post'.
 * Correct: content = JSON.stringify({ zh_cn: { title: "...", content: [...] } })
 * Wrong: content = JSON.stringify({ post: { zh_cn: { ... } } })
 *
 * @param elements - 2D array of post elements (rows of segments)
 * @param title - Optional title for the post
 * @returns JSON string suitable for Feishu API content field
 *
 * @example
 * const elements: PostElement[][] = [
 *   [{ tag: 'text', text: 'Hello ' }],
 *   [{ tag: 'text', text: 'World' }]
 * ];
 * const content = buildPostContent(elements, 'Title');
 * // Returns: '{"zh_cn":{"title":"Title","content":[[{"tag":"text","text":"Hello "}],[{"tag":"text","text":"World"}]]}}'
 */
export function buildPostContent(elements: PostElement[][], title?: string): string {
  const postContent: PostContent = {
    zh_cn: {
      content: elements,
    },
  };

  if (title) {
    postContent.zh_cn.title = title;
  }

  return JSON.stringify(postContent);
}

/**
 * Helper to create a simple post content from plain text.
 * Converts plain text into a post format with a single text element.
 *
 * @param text - Plain text content
 * @param title - Optional title for the post
 * @returns JSON string suitable for Feishu API content field
 *
 * @example
 * const content = buildSimplePostContent('Hello, world!', 'Greeting');
 * // Returns: '{"zh_cn":{"title":"Greeting","content":[[{"tag":"text","text":"Hello, world!"}]]}}'
 */
export function buildSimplePostContent(text: string, title?: string): string {
  const element: PostTextElement = {
    tag: 'text',
    text,
  };

  return buildPostContent([[element]], title);
}

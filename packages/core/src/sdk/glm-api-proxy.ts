/**
 * GLM API Proxy — 第三方 Claude 兼容端点的工具定义适配层 (Issue #2948)
 *
 * ## 问题
 * Claude Agent SDK 将工具定义嵌入 system prompt (XML 格式)，
 * 而非通过 `tools` API 参数发送。Anthropic 原生 API 两种都支持，
 * 但 GLM 等第三方端点只认 `tools` 参数，导致系统工具全部丢失。
 *
 * ## 解决方案
 * 在 SDK subprocess 和第三方 API 之间插入本地 HTTP 代理：
 * 1. 拦截 API 请求
 * 2. 从 system prompt 中提取 XML 工具定义
 * 3. 转换为 Anthropic `tools` API 参数格式
 * 4. 转发修改后的请求
 * 5. 响应原样透传（GLM 使用 `tools` 参数时能正常返回结构化 tool_use）
 *
 * ## 架构
 * ```
 * SDK subprocess → localhost:{port}/v1/messages → GlmApiProxy → GLM API
 *                                        ↓
 *                                提取工具定义 + 添加 tools 参数
 * ```
 *
 * @module sdk/glm-api-proxy
 */

import { createServer, request as http_request, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { request as https_request } from 'https';
import { parse as parseUrl } from 'url';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('GlmApiProxy');

// ============================================================================
// 类型定义
// ============================================================================

/** Anthropic API 工具定义格式 */
export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

/** 代理配置 */
export interface GlmApiProxyOptions {
  /** 目标 API base URL (e.g., 'https://open.bigmodel.cn/api/anthropic') */
  targetUrl: string;
  /** 最大请求体大小 (bytes, default 10MB) */
  maxBodySize?: number;
}

// ============================================================================
// 工具定义提取
// ============================================================================

/**
 * 从 system prompt 中提取工具定义
 *
 * 支持的 XML 格式：
 * 1. `<functions><function>{JSON}</function></functions>`
 * 2. `<tools><tool>{JSON}</tool></tools>`
 * 3. `<tool_def name="..."><description>...</description><parameters>{JSON}</parameters></tool_def>`
 *
 * 每种格式中的 JSON 应包含 name, description, parameters 字段。
 *
 * @param systemPrompt - system prompt 文本
 * @returns 提取到的工具定义数组
 */
export function extractToolDefinitions(systemPrompt: string): ToolDefinition[] {
  if (!systemPrompt || typeof systemPrompt !== 'string') {
    return [];
  }

  const tools: ToolDefinition[] = [];

  // 格式 1: <functions><function>{JSON}</function></functions>
  extractFromXmlBlock(systemPrompt, 'functions', 'function', tools);

  // 格式 2: <tools><tool>{JSON}</tool></tools>
  // (仅当格式 1 没有找到结果时尝试，避免重复提取)
  if (tools.length === 0) {
    extractFromXmlBlock(systemPrompt, 'tools', 'tool', tools);
  }

  // 格式 3: <tool_def name="...">...</tool_def>
  if (tools.length === 0) {
    extractToolDefFormat(systemPrompt, tools);
  }

  if (tools.length > 0) {
    logger.info({ toolCount: tools.length, toolNames: tools.map(t => t.name) }, 'Extracted tool definitions from system prompt');
  } else {
    logger.debug('No tool definitions found in system prompt');
  }

  return tools;
}

/**
 * 从 XML 块中提取 JSON 工具定义
 */
function extractFromXmlBlock(
  text: string,
  outerTag: string,
  innerTag: string,
  tools: ToolDefinition[],
): void {
  const outerRegex = new RegExp(`<${outerTag}[^>]*>([\\s\\S]*?)<\\/${outerTag}>`, 'g');
  let outerMatch;
  while ((outerMatch = outerRegex.exec(text)) !== null) {
    const [, outerCapture] = outerMatch;
    const block = outerCapture;
    const innerRegex = new RegExp(`<${innerTag}[^>]*>([\\s\\S]*?)<\\/${innerTag}>`, 'g');
    let innerMatch;
    while ((innerMatch = innerRegex.exec(block)) !== null) {
      const [, innerCapture] = innerMatch;
      const json = innerCapture.trim();
      const tool = parseToolJson(json);
      if (tool) {
        tools.push(tool);
      }
    }
  }
}

/**
 * 从 <tool_def> 格式提取
 */
function extractToolDefFormat(text: string, tools: ToolDefinition[]): void {
  const regex = /<tool_def\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/tool_def>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const [, nameMatch, bodyMatch] = match;
    const name = nameMatch;
    const body = bodyMatch;

    let description = '';
    let parameters: Record<string, unknown> = { type: 'object', properties: {} };

    const descMatch = body.match(/<description>([\s\S]*?)<\/description>/);
    if (descMatch) {
      description = descMatch[1].trim();
    }

    const paramMatch = body.match(/<parameters>([\s\S]*?)<\/parameters>/);
    if (paramMatch) {
      try {
        parameters = JSON.parse(paramMatch[1].trim());
      } catch {
        // keep default empty schema
      }
    }

    tools.push({ name, description, input_schema: parameters });
  }
}

/**
 * 解析 JSON 格式的工具定义
 */
function parseToolJson(json: string): ToolDefinition | null {
  try {
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object' || !obj.name) {
      return null;
    }

    return {
      name: obj.name,
      description: obj.description || '',
      input_schema: obj.parameters || obj.input_schema || { type: 'object', properties: {} },
    };
  } catch {
    return null;
  }
}

// ============================================================================
// HTTP 代理
// ============================================================================

/**
 * GLM API 代理服务器
 *
 * 启动本地 HTTP 服务器，拦截发往第三方 Claude 兼容端点的请求，
 * 自动从 system prompt 中提取工具定义并添加 `tools` API 参数。
 */
export class GlmApiProxy {
  private server: Server | null = null;
  private readonly targetUrl: string;
  private readonly maxBodySize: number;
  private port_ = 0;
  private requestCount = 0;

  constructor(options: GlmApiProxyOptions) {
    this.targetUrl = options.targetUrl.replace(/\/+$/, ''); // 去掉尾部斜杠
    this.maxBodySize = options.maxBodySize ?? 10 * 1024 * 1024; // 10MB
  }

  /** 获取代理监听端口 */
  get port(): number {
    return this.port_;
  }

  /** 获取代理 URL (用于设置为 ANTHROPIC_BASE_URL) */
  getUrl(): string {
    return `http://127.0.0.1:${this.port_}`;
  }

  /** 获取已处理的请求数 */
  getRequestCount(): number {
    return this.requestCount;
  }

  /**
   * 启动代理服务器
   * @returns 监听端口号
   */
  async start(): Promise<number> {
    if (this.server) {
      return this.port_;
    }

    const server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        logger.error({ err, url: req.url }, 'Proxy request handler error');
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'proxy_error', message: String(err) }));
      });
    });

    this.server = server;

    return await new Promise((resolve, reject) => {
      server.on('error', (err) => {
        logger.error({ err }, 'Proxy server error');
        reject(err);
      });

      // 监听随机端口
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          this.port_ = addr.port;
          logger.info({ port: this.port_, target: this.targetUrl }, 'GLM API proxy started');
          resolve(this.port_);
        } else {
          reject(new Error('Failed to get proxy port'));
        }
      });
    });
  }

  /**
   * 停止代理服务器
   */
  async stop(): Promise<void> {
    const { server } = this;
    if (!server) {
      return;
    }

    this.server = null;

    return await new Promise((resolve) => {
      server.close(() => {
        logger.info({ port: this.port_ }, 'GLM API proxy stopped');
        this.port_ = 0;
        resolve();
      });
    });
  }

  /**
   * 处理传入请求
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requestCount++;

    // 只处理 POST /v1/messages (Anthropic API 端点)
    if (req.method !== 'POST' || !req.url?.includes('/v1/messages')) {
      // 非 messages 端点直接转发
      await this.forwardRequest(req, '', res, false);
      return;
    }

    // 读取请求体
    const body = await this.readBody(req);

    // 尝试解析 JSON 并提取工具定义
    let modifiedBody = body;
    try {
      const parsed = JSON.parse(body);
      const modified = this.transformRequest(parsed);
      if (modified) {
        modifiedBody = JSON.stringify(modified);
        logger.debug(
          { url: req.url, hasTools: !!(modified as Record<string, unknown>).tools },
          'Request transformed with tools parameter',
        );
      }
    } catch {
      logger.debug({ url: req.url }, 'Non-JSON request, forwarding as-is');
    }

    // 转发修改后的请求
    await this.forwardRequest(req, modifiedBody, res, true);
  }

  /**
   * 转换请求：提取工具定义并添加 tools 参数
   *
   * @returns 修改后的请求对象，如果不需要修改返回 null
   */
  private transformRequest(request: Record<string, unknown>): Record<string, unknown> | null {
    // 如果请求已经有 tools 参数，不需要修改
    if (request.tools && Array.isArray(request.tools) && request.tools.length > 0) {
      logger.debug('Request already has tools parameter, skipping transformation');
      return null;
    }

    // 获取 system prompt
    const systemPrompt = this.getSystemPrompt(request);
    if (!systemPrompt) {
      logger.debug('No system prompt found in request');
      return null;
    }

    // 提取工具定义
    const tools = extractToolDefinitions(systemPrompt);
    if (tools.length === 0) {
      return null;
    }

    // 添加 tools 参数
    const modified = { ...request };
    modified.tools = tools.map(t => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.input_schema,
    }));

    // 设置 stop_reason 以支持工具调用
    // Anthropic API 默认就支持 tool_use stop_reason，无需额外设置

    return modified;
  }

  /**
   * 从请求中获取 system prompt
   *
   * Anthropic API 支持两种方式传递 system prompt：
   * 1. 顶层 `system` 参数 (字符串或数组)
   * 2. messages 数组中 role=system 的消息
   */
  private getSystemPrompt(request: Record<string, unknown>): string | null {
    // 方式 1: 顶层 system 参数
    if (request.system) {
      if (typeof request.system === 'string') {
        return request.system;
      }
      // Anthropic API 也支持 system 为 TextBlock 数组
      if (Array.isArray(request.system)) {
        return request.system
          .map((block: unknown) => {
            if (typeof block === 'object' && block !== null && 'text' in block) {
              return (block as { text: string }).text;
            }
            return String(block);
          })
          .join('\n');
      }
    }

    // 方式 2: messages 中的 system 消息
    if (Array.isArray(request.messages)) {
      const systemParts: string[] = [];
      for (const msg of request.messages as Array<Record<string, unknown>>) {
        if (msg.role === 'system') {
          if (typeof msg.content === 'string') {
            systemParts.push(msg.content);
          } else if (Array.isArray(msg.content)) {
            for (const block of msg.content as Array<Record<string, unknown>>) {
              if (typeof block === 'object' && block !== null && 'text' in block) {
                systemParts.push((block as { text: string }).text);
              }
            }
          }
        }
      }
      if (systemParts.length > 0) {
        return systemParts.join('\n');
      }
    }

    return null;
  }

  /**
   * 读取请求体
   */
  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.maxBodySize) {
          reject(new Error(`Request body exceeds maximum size of ${this.maxBodySize} bytes`));
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });

      req.on('error', reject);
    });
  }

  /**
   * 转发请求到目标 API
   *
   * 支持流式和非流式响应的透传。
   */
  private forwardRequest(
    req: IncomingMessage,
    body: string,
    res: ServerResponse,
    hasBody: boolean,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsedTarget = parseUrl(this.targetUrl);
      const targetPath = parsedTarget.path?.replace(/\/+$/, '') || '';
      const requestPath = req.url || '/v1/messages';

      // 构建完整路径：targetBasePath + requestPath
      // 例如: targetUrl = https://open.bigmodel.cn/api/anthropic
      //        requestPath = /v1/messages
      //        fullPath = /api/anthropic/v1/messages
      const fullPath = requestPath.startsWith('/')
        ? `${targetPath}${requestPath}`
        : `${targetPath}/${requestPath}`;

      const isHttps = parsedTarget.protocol === 'https:';
      const requestFn = isHttps ? https_request : http_request;

      const proxyReq = requestFn({
        hostname: parsedTarget.hostname,
        port: parsedTarget.port || (isHttps ? 443 : 80),
        path: fullPath,
        method: req.method,
        headers: {
          ...filterForwardableHeaders(req.headers),
          host: parsedTarget.hostname ?? undefined,
          // 保持内容长度准确
          ...(hasBody && body ? { 'content-length': Buffer.byteLength(body).toString() } : {}),
        },
      }, (proxyRes) => {
        // 写入响应头
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        // 管道传输响应体（支持流式 SSE）
        proxyRes.pipe(res);

        proxyRes.on('end', resolve);
        proxyRes.on('error', reject);
      });

      proxyReq.on('error', (err) => {
        logger.error({ err, url: req.url }, 'Proxy forwarding error');
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'proxy_forward_error', message: err.message }));
        }
        resolve();
      });

      if (hasBody && body) {
        proxyReq.write(body);
      }
      proxyReq.end();
    });
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 过滤可转发的请求头
 * 移除 hop-by-hop 头和代理相关头
 */
function filterForwardableHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const filtered: Record<string, string | string[]> = {};
  const skipHeaders = new Set([
    'host', 'connection', 'keep-alive', 'transfer-encoding',
    'te', 'trailer', 'upgrade', 'proxy-connection',
  ]);

  for (const [key, value] of Object.entries(headers)) {
    if (!skipHeaders.has(key.toLowerCase()) && value !== undefined) {
      filtered[key] = value;
    }
  }
  return filtered;
}

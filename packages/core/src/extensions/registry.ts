/**
 * 统一扩展注册表核心(Issue #5745 Part 1)
 *
 * 为 harness / channel 类型 / LLM 接入三类扩展提供同一份注册契约:
 * 类型标识 + 来源标记 + 生命周期(register/unregister/override)+ 错误隔离。
 * 内置实现与第三方扩展走同一条注册路径——内置只是预注册的普通扩展,
 * 消除双轨。配置 schema 校验与外部模块加载由后续部件在本核心之上叠加。
 *
 * 错误隔离语义:任何一次失败的 register/unregister 只影响该条目本身,
 * 注册表内其他条目与既有顺序保持不变;校验在写入前完成。
 */

/** 扩展来源:内置预注册 or 第三方运行期注册 */
export type ExtensionSource = 'builtin' | 'external';

/** 单条已注册扩展的不可变记录 */
export interface ExtensionRecord<T> {
  readonly id: string;
  readonly kind: string;
  readonly source: ExtensionSource;
  readonly descriptor: T;
}

/** register() 选项 */
export interface RegisterOptions {
  /** 来源标记,默认 external(内置预注册须显式传 builtin) */
  readonly source?: ExtensionSource;
  /** 是否覆盖同 id 既有条目,默认 false(重复注册即错误,防静默替换) */
  readonly override?: boolean;
}

/** 注册失败(校验不过/重复 id)。绝不影响其他条目。 */
export class ExtensionRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionRegistrationError';
  }
}

function validateId(kind: string, id: string): string {
  if (typeof id !== 'string' || id.length === 0 || id.trim().length === 0 || /\s/.test(id)) {
    throw new ExtensionRegistrationError(
      `${kind} extension id must be a non-empty string without whitespace, got: ${JSON.stringify(id)}`
    );
  }
  return id;
}

/**
 * 一个扩展分区的类型化注册表。
 *
 * 同一 ExtensionSection 实例即一类扩展(harness / channelType / llmAccess)
 * 的唯一注册面;插入顺序稳定,枚举顺序即注册顺序(内置在前)。
 */
export class ExtensionSection<T> {
  private readonly entries = new Map<string, ExtensionRecord<T>>();

  constructor(readonly kind: string) {}

  /**
   * 注册一条扩展。重复 id 默认抛错(override 显式覆盖)。
   * 覆盖时保留原条目的插入位置,仅替换内容与来源。
   */
  register(id: string, descriptor: T, options: RegisterOptions = {}): ExtensionRecord<T> {
    const validId = validateId(this.kind, id);
    if (descriptor === null || descriptor === undefined) {
      throw new ExtensionRegistrationError(
        `${this.kind} extension "${validId}" descriptor must not be null or undefined`
      );
    }
    if (this.entries.has(validId) && !options.override) {
      throw new ExtensionRegistrationError(
        `${this.kind} extension "${validId}" is already registered (source: ${
          this.entries.get(validId)?.source
        }); pass { override: true } to replace it`
      );
    }
    const record: ExtensionRecord<T> = {
      id: validId,
      kind: this.kind,
      source: options.source ?? 'external',
      descriptor,
    };
    this.entries.set(validId, record);
    return record;
  }

  /** 注销一条扩展;不存在返回 false,存在则移除并返回 true。 */
  unregister(id: string): boolean {
    return this.entries.delete(id);
  }

  /** 取描述符;未注册返回 undefined。 */
  get(id: string): T | undefined {
    return this.entries.get(id)?.descriptor;
  }

  /** 取描述符;未注册抛错并列出可用 id(错误信息供 CLI/配置诊断直用)。 */
  require(id: string): T {
    const descriptor = this.get(id);
    if (descriptor === undefined) {
      throw new Error(
        `Unknown ${this.kind} extension: ${id}. Available: ${this.ids().join(', ')}`
      );
    }
    return descriptor;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** 已注册 id 列表,按注册顺序。 */
  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** 全部记录(含来源),按注册顺序;用于能力枚举与 /agent 等展示面。 */
  records(): ExtensionRecord<T>[] {
    return [...this.entries.values()];
  }

  /** 描述符迭代(注册顺序);等价旧 Map 遍历,便于既有消费方迁移。 */
  *descriptors(): IterableIterator<T> {
    for (const record of this.entries.values()) {
      yield record.descriptor;
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Offline Card JSON 2.0 component catalog, field help and local validation.
 *
 * This module is a deliberately partial, offline snapshot of the Feishu Card
 * JSON 2.0 surface. It never claims full spec compatibility: every result
 * carries the snapshot provenance and the list of rules that are NOT checked.
 *
 * @module channel-cli/utils/card2-help
 */

/** Stable diagnostic codes. These strings are the CLI contract; never rename. */
export type Card2DiagnosticCode =
  | 'CARD_ENVELOPE_MISSING'
  | 'CARD_ENVELOPE_TYPE'
  | 'CARD_FIELD_MISSING'
  | 'CARD_FIELD_TYPE'
  | 'CARD_ENUM_INVALID'
  | 'CARD_ELEMENT_ID_DUPLICATE'
  | 'CARD_COMPONENT_NOT_IN_CATALOG'
  | 'CARD_NESTING_DEPTH'
  | 'CARD_NESTING_UNSUPPORTED'
  | 'CARD_GFM_TABLE';

export interface Card2Diagnostic {
  code: Card2DiagnosticCode;
  /** RFC 6901 JSON Pointer into the supplied card JSON. */
  pointer: string;
  reason: string;
  /** CLI entry point that documents the offending component or envelope. */
  help: string;
}

export interface Card2SpecProvenance {
  schema: '2.0';
  /** Date this curated snapshot was written; not an upstream version. */
  snapshotDate: '2026-11-05';
  completeness: 'partial';
  sources: Array<{ title: string; url: string; upstreamLastUpdated: string }>;
  coveredRules: string[];
  notCoveredRules: string[];
}

export interface Card2FieldHelp {
  name: string;
  required: boolean;
  type: string;
  enumValues?: string[];
  description: string;
}

export interface Card2ComponentHelp {
  tag: string;
  kind: 'envelope' | 'layout' | 'content';
  summary: string;
  keywords: string[];
  fields: Card2FieldHelp[];
  example: Record<string, unknown>;
  /** Documented nesting restriction that this validator enforces. */
  nestingNote?: string;
}

const HELP_ENTRY = 'disclaude channel card_help';

export const CARD2_SPEC: Card2SpecProvenance = {
  schema: '2.0',
  snapshotDate: '2026-11-05',
  completeness: 'partial',
  sources: [
    {
      title: 'Card JSON 2.0 structure',
      url: 'https://open.feishu.cn/document/feishu-cards/card-json-v2-structure',
      upstreamLastUpdated: '2025-06-23',
    },
    {
      title: 'Collapsible panel (Card JSON 2.0 component)',
      url: 'https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/collapsible-panel',
      upstreamLastUpdated: '2024-12-31',
    },
  ],
  coveredRules: [
    'schema="2.0" envelope: header (object, title.tag/content), body.elements (array)',
    'markdown element content type',
    'column_set.columns[] and column.elements[] container shapes',
    'collapsible_panel header, expanded boolean and direction enum',
    'element_id syntax and card-wide uniqueness',
    'container nesting depth limit of 5',
    'collapsible_panel must not contain form components',
    'GFM pipe tables inside markdown are reported (Feishu markdown cannot render them)',
  ],
  notCoveredRules: [
    'components outside the catalog below (form, action, chart, image, icon, i18n, card_link, custom style, etc.)',
    'config.* behavior fields (streaming, summary, forwarding, width mode, translation)',
    'numeric/length limits, color enums, px spacing ranges',
    'card-level element count and payload size limits',
    'Feishu client version availability and runtime acceptance',
  ],
};

export const CARD2_COMPONENTS: Card2ComponentHelp[] = [
  {
    tag: 'card',
    kind: 'envelope',
    summary: 'Card JSON 2.0 root: schema="2.0", required header and body.elements.',
    keywords: ['envelope', 'root', 'schema', 'header', 'body'],
    fields: [
      { name: 'schema', required: true, type: '"2.0"', enumValues: ['2.0'], description: 'Must be explicitly "2.0" for the Card JSON 2.0 structure.' },
      { name: 'config', required: false, type: 'object', description: 'Card behavior settings; not field-validated by this offline snapshot.' },
      { name: 'header', required: true, type: 'object', description: 'Card title block.' },
      { name: 'body', required: true, type: 'object', description: 'Card body container holding elements.' },
    ],
    example: { schema: '2.0', header: { title: { tag: 'plain_text', content: '标题' } }, body: { elements: [] } },
  },
  {
    tag: 'header',
    kind: 'envelope',
    summary: 'Card title block; title is required.',
    keywords: ['title', '标题', 'subtitle', 'template'],
    fields: [
      { name: 'title', required: true, type: 'object', description: 'Title text object.' },
      { name: 'title.tag', required: true, type: 'string', enumValues: ['plain_text', 'lark_md'], description: 'Title text type.' },
      { name: 'title.content', required: true, type: 'string', description: 'Title text.' },
      { name: 'subtitle', required: false, type: 'object', description: 'Optional subtitle text object; not field-validated here.' },
      { name: 'template', required: false, type: 'string', description: 'Title color theme; enum not validated here.' },
    ],
    example: { title: { tag: 'plain_text', content: '标题' }, subtitle: { tag: 'plain_text', content: '副标题' }, template: 'blue' },
  },
  {
    tag: 'markdown',
    kind: 'content',
    summary: 'Rich text block. GFM pipe tables are not renderable; use column_set.',
    keywords: ['text', 'rich', '文本', 'table', '表格'],
    fields: [
      { name: 'tag', required: true, type: 'string', enumValues: ['markdown'], description: 'Fixed value "markdown".' },
      { name: 'content', required: true, type: 'string', description: 'Markdown text. Pipe tables render as raw text.' },
      { name: 'element_id', required: false, type: 'string', description: 'Unique component identifier (see card help).' },
    ],
    example: { tag: 'markdown', content: '**完成率** 82%' },
  },
  {
    tag: 'column_set',
    kind: 'layout',
    summary: 'Multi-column layout container for metric rows and tables.',
    keywords: ['column', 'layout', '分栏', 'metrics', '指标'],
    fields: [
      { name: 'tag', required: true, type: 'string', enumValues: ['column_set'], description: 'Fixed value "column_set".' },
      { name: 'columns', required: true, type: 'array<object>', description: 'Column list; each item is a column component.' },
      { name: 'flex_mode', required: false, type: 'string', description: 'Layout mode; enum not validated here.' },
      { name: 'background_style', required: false, type: 'string', description: 'Background style; enum not validated here.' },
      { name: 'element_id', required: false, type: 'string', description: 'Unique component identifier (see card help).' },
    ],
    nestingNote: 'Containers may nest at most 5 layers deep.',
    example: {
      tag: 'column_set',
      flex_mode: 'none',
      background_style: 'default',
      columns: [
        { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: '**吞吐** 1.2k/d' }] },
        { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: '**错误率** 0.3%' }] },
      ],
    },
  },
  {
    tag: 'column',
    kind: 'layout',
    summary: 'One column inside column_set; holds nested elements.',
    keywords: ['column', '列', 'width', 'weight'],
    fields: [
      { name: 'tag', required: true, type: 'string', enumValues: ['column'], description: 'Fixed value "column".' },
      { name: 'elements', required: true, type: 'array<object>', description: 'Components rendered inside the column.' },
      { name: 'width', required: false, type: 'string', description: 'Column width mode; enum not validated here.' },
      { name: 'weight', required: false, type: 'number', description: 'Weighted width share.' },
    ],
    nestingNote: 'Containers may nest at most 5 layers deep.',
    example: { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: '**待办** 3' }] },
  },
  {
    tag: 'collapsible_panel',
    kind: 'layout',
    summary: 'Fold secondary detail behind a clickable header.',
    keywords: ['collapse', 'fold', '折叠', 'details', '详情'],
    fields: [
      { name: 'tag', required: true, type: 'string', enumValues: ['collapsible_panel'], description: 'Fixed value "collapsible_panel".' },
      { name: 'header', required: true, type: 'object', description: 'Panel title settings; required.' },
      { name: 'header.title', required: false, type: 'object', description: 'Title text object with tag/content when present.' },
      { name: 'expanded', required: false, type: 'boolean', enumValues: ['true', 'false'], description: 'Initial expanded state; default false.' },
      { name: 'direction', required: false, type: 'string', enumValues: ['vertical', 'horizontal'], description: 'Arrangement of children; default vertical.' },
      { name: 'background_color', required: false, type: 'string', description: 'Background color; enum not validated here.' },
      { name: 'element_id', required: false, type: 'string', description: 'Unique identifier matching ^[A-Za-z][A-Za-z0-9_]{0,19}$.' },
    ],
    nestingNote: 'Max 5 container layers; form components are not supported inside.',
    example: {
      tag: 'collapsible_panel',
      expanded: false,
      background_color: 'grey',
      header: { title: { tag: 'markdown', content: '详情' } },
      elements: [{ tag: 'markdown', content: '折叠的次要信息' }],
    },
  },
  {
    tag: 'hr',
    kind: 'content',
    summary: 'Horizontal divider.',
    keywords: ['divider', 'line', '分隔'],
    fields: [{ name: 'tag', required: true, type: 'string', enumValues: ['hr'], description: 'Fixed value "hr"; no content fields.' }],
    example: { tag: 'hr' },
  },
];

/** Editable native example: metric columns plus a collapsible detail panel. */
export const METRICS_COLLAPSIBLE_EXAMPLE: Record<string, unknown> = {
  schema: '2.0',
  config: { update_multi: true, enable_forward: true },
  header: {
    title: { tag: 'plain_text', content: '交付指标速览' },
    subtitle: { tag: 'plain_text', content: 'Card JSON 2.0 离线示例' },
    template: 'blue',
  },
  body: {
    direction: 'vertical',
    elements: [
      {
        tag: 'column_set',
        flex_mode: 'none',
        background_style: 'default',
        columns: [
          { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: '**构建**\n通过' }] },
          { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: '**测试**\n6 失败为基线' }] },
          { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: '**发布**\n未执行' }] },
        ],
      },
      { tag: 'hr' },
      {
        tag: 'collapsible_panel',
        element_id: 'detail_panel',
        expanded: false,
        background_color: 'grey',
        header: { title: { tag: 'markdown', content: '折叠详情（本示例可编辑后重新 card_check）' } },
        elements: [
          { tag: 'markdown', content: '- 指标列来自 column_set\n- 次要说明放折叠面板\n- 修改后先离线校验，再考虑发送' },
        ],
      },
    ],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function pointerAt(base: string, indexOrKey: number | string): string {
  return `${base}/${escapePointerSegment(String(indexOrKey))}`;
}

function diagnostic(
  code: Card2DiagnosticCode,
  pointer: string,
  reason: string,
  component?: string,
): Card2Diagnostic {
  return {
    code,
    pointer,
    reason,
    help: component && component !== 'card'
      ? `${HELP_ENTRY} --component ${component}`
      : HELP_ENTRY,
  };
}

export interface Card2CheckResult {
  valid: boolean;
  diagnostics: Card2Diagnostic[];
  /** Re-stated provenance so a pass is never read as full-spec compatibility. */
  spec: Card2SpecProvenance;
}

const CATALOG_TAGS = new Set(['markdown', 'column_set', 'column', 'collapsible_panel', 'hr']);

interface ValidationState {
  diagnostics: Card2Diagnostic[];
  elementIds: Map<string, string>;
}

function checkElementId(
  element: Record<string, unknown>,
  pointer: string,
  tag: string,
  state: ValidationState,
): void {
  const elementId = element.element_id;
  if (elementId === undefined) {return;}
  if (typeof elementId !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(elementId)) {
    state.diagnostics.push(diagnostic(
      'CARD_FIELD_TYPE', `${pointer}/element_id`,
      'element_id must match ^[A-Za-z][A-Za-z0-9_]{0,19}$ (letters, numbers, underscores; starts with a letter; max 20 chars)',
      tag,
    ));
    return;
  }
  const firstPointer = state.elementIds.get(elementId);
  if (firstPointer !== undefined) {
    state.diagnostics.push(diagnostic(
      'CARD_ELEMENT_ID_DUPLICATE', `${pointer}/element_id`,
      `element_id "${elementId}" duplicates the one at ${firstPointer}; it must be unique within the card`,
      tag,
    ));
    return;
  }
  state.elementIds.set(elementId, pointer);
}

function checkTextObject(
  value: unknown,
  pointer: string,
  parentTag: string,
  state: ValidationState,
): void {
  if (!isRecord(value)) {
    state.diagnostics.push(diagnostic('CARD_FIELD_TYPE', pointer, 'text object must be an object with tag and content', parentTag));
    return;
  }
  if (value.tag !== 'plain_text' && value.tag !== 'markdown' && value.tag !== 'lark_md') {
    state.diagnostics.push(diagnostic(
      'CARD_ENUM_INVALID', `${pointer}/tag`,
      `tag must be one of: plain_text, markdown, lark_md (received ${JSON.stringify(value.tag) ?? 'undefined'})`,
      parentTag,
    ));
  }
  if (typeof value.content !== 'string') {
    state.diagnostics.push(diagnostic('CARD_FIELD_TYPE', `${pointer}/content`, 'content must be a string', parentTag));
  }
}

function checkElementsArray(
  value: unknown,
  pointer: string,
  parentTag: string,
  state: ValidationState,
  depth: number,
): void {
  if (!Array.isArray(value)) {
    state.diagnostics.push(diagnostic('CARD_FIELD_TYPE', pointer, `${parentTag} elements must be an array`, parentTag));
    return;
  }
  value.forEach((child, index) => {
    checkElement(child, pointerAt(pointer, index), state, depth + 1, parentTag);
  });
}

function checkElement(
  value: unknown,
  pointer: string,
  state: ValidationState,
  depth: number,
  parentTag?: string,
): void {
  if (!isRecord(value)) {
    state.diagnostics.push(diagnostic(
      'CARD_FIELD_TYPE', pointer,
      parentTag ? `each ${parentTag} child element must be an object` : 'each body element must be an object',
      parentTag ?? 'card',
    ));
    return;
  }
  const tag = typeof value.tag === 'string' ? value.tag : undefined;
  if (tag === undefined) {
    state.diagnostics.push(diagnostic('CARD_FIELD_MISSING', `${pointer}/tag`, 'element tag is required', 'card'));
    return;
  }
  if (!CATALOG_TAGS.has(tag)) {
    state.diagnostics.push(diagnostic(
      'CARD_COMPONENT_NOT_IN_CATALOG', `${pointer}/tag`,
      `component "${tag}" is outside this offline catalog; it is explicitly NOT verified here (partial snapshot)`,
    ));
    return;
  }
  if (depth > 5) {
    state.diagnostics.push(diagnostic('CARD_NESTING_DEPTH', pointer, 'container components support at most 5 nested layers', tag));
  }
  checkElementId(value, pointer, tag, state);

  switch (tag) {
    case 'markdown':
      if (typeof value.content !== 'string') {
        state.diagnostics.push(diagnostic('CARD_FIELD_TYPE', `${pointer}/content`, 'markdown content must be a string', tag));
      } else if (containsPipeTable(value.content)) {
        state.diagnostics.push(diagnostic(
          'CARD_GFM_TABLE', `${pointer}/content`,
          'GFM pipe table syntax is not renderable in card markdown; use column_set columns instead',
          'column_set',
        ));
      }
      break;
    case 'hr':
      break;
    case 'column_set': {
      if (!Array.isArray(value.columns)) {
        state.diagnostics.push(diagnostic('CARD_FIELD_TYPE', `${pointer}/columns`, 'column_set columns must be an array', tag));
        return;
      }
      value.columns.forEach((column, index) => {
        const columnPointer = pointerAt(`${pointer}/columns`, index);
        if (!isRecord(column) || column.tag !== 'column') {
          state.diagnostics.push(diagnostic('CARD_FIELD_TYPE', `${columnPointer}/tag`, 'each columns item must be an object with tag "column"', tag));
          return;
        }
        checkElementId(column, columnPointer, 'column', state);
        checkElementsArray(column.elements, `${columnPointer}/elements`, 'column', state, depth);
      });
      break;
    }
    case 'column':
      checkElementsArray(value.elements, `${pointer}/elements`, 'column', state, depth);
      break;
    case 'collapsible_panel': {
      if (!isRecord(value.header)) {
        state.diagnostics.push(diagnostic('CARD_FIELD_MISSING', `${pointer}/header`, 'collapsible_panel header is required', tag));
      } else if (value.header.title !== undefined) {
        checkTextObject(value.header.title, `${pointer}/header/title`, tag, state);
      }
      if (value.expanded !== undefined && typeof value.expanded !== 'boolean') {
        state.diagnostics.push(diagnostic(
          'CARD_ENUM_INVALID', `${pointer}/expanded`,
          `expanded must be a boolean: true or false (received ${JSON.stringify(value.expanded)})`,
          tag,
        ));
      }
      if (value.direction !== undefined && value.direction !== 'vertical' && value.direction !== 'horizontal') {
        state.diagnostics.push(diagnostic(
          'CARD_ENUM_INVALID', `${pointer}/direction`,
          `direction must be one of: vertical, horizontal (received ${JSON.stringify(value.direction)})`,
          tag,
        ));
      }
      const children = value.elements;
      if (!Array.isArray(children)) {
        state.diagnostics.push(diagnostic('CARD_FIELD_TYPE', `${pointer}/elements`, 'collapsible_panel elements must be an array', tag));
        return;
      }
      children.forEach((child, index) => {
        const childPointer = pointerAt(`${pointer}/elements`, index);
        if (isRecord(child) && typeof child.tag === 'string' && child.tag.startsWith('form')) {
          state.diagnostics.push(diagnostic(
            'CARD_NESTING_UNSUPPORTED', `${childPointer}/tag`,
            'collapsible_panel does not support embedding form components',
            tag,
          ));
          return;
        }
        checkElement(child, childPointer, state, depth + 1, tag);
      });
      break;
    }
    default:
      break;
  }
}

/** Detect a GFM separator row, the reliable marker of a pipe table. */
function containsPipeTable(content: string): boolean {
  return content.split('\n').some(line => /^\|[\s\-:]+(\|[\s\-:]+)+\|?\s*$/.test(line.trim()));
}

/**
 * Validate a Card JSON 2.0 object against the covered subset only.
 * Unknown-but-legal components are reported as not verified, never as
 * "compatible with the full specification".
 */
export function checkCard2(card: unknown): Card2CheckResult {
  const state: ValidationState = { diagnostics: [], elementIds: new Map() };
  if (!isRecord(card)) {
    state.diagnostics.push(diagnostic('CARD_ENVELOPE_TYPE', '', `card must be a JSON object (received ${Array.isArray(card) ? 'array' : typeof card})`));
  } else if (card.schema !== '2.0') {
    state.diagnostics.push(diagnostic(
      'CARD_ENVELOPE_MISSING', '/schema',
      `schema must be the string "2.0" for Card JSON 2.0 validation (received ${JSON.stringify(card.schema) ?? 'undefined'})`,
    ));
  } else {
    if (!isRecord(card.header)) {
      state.diagnostics.push(diagnostic('CARD_FIELD_MISSING', '/header', 'header is required and must be an object', 'card'));
    } else {
      if (card.header.title === undefined) {
        state.diagnostics.push(diagnostic('CARD_FIELD_MISSING', '/header/title', 'header.title is required', 'header'));
      } else {
        checkTextObject(card.header.title, '/header/title', 'header', state);
      }
    }
    if (!isRecord(card.body)) {
      state.diagnostics.push(diagnostic('CARD_FIELD_MISSING', '/body', 'body is required and must be an object', 'card'));
    } else if (!Array.isArray(card.body.elements)) {
      state.diagnostics.push(diagnostic('CARD_FIELD_TYPE', '/body/elements', 'body.elements must be an array', 'card'));
    } else {
      card.body.elements.forEach((element, index) => {
        checkElement(element, pointerAt('/body/elements', index), state, 1);
      });
    }
    if (card.config !== undefined && !isRecord(card.config)) {
      state.diagnostics.push(diagnostic('CARD_FIELD_TYPE', '/config', 'config must be an object when provided', 'card'));
    }
  }
  return { valid: state.diagnostics.length === 0, diagnostics: state.diagnostics, spec: CARD2_SPEC };
}

export interface Card2HelpResult {
  command: 'card_help';
  spec: Card2SpecProvenance;
  components?: Array<{ tag: string; kind: string; summary: string }>;
  component?: Card2ComponentHelp;
  examples?: Array<{ name: string; description: string; card: Record<string, unknown> }>;
}

/**
 * Offline component index/search. With no filters this returns the index and
 * the editable example; `query`/`component` narrow it.
 */
export function buildCard2Help(options: { query?: string; component?: string } = {}): Card2HelpResult {
  const base: Card2HelpResult = {
    command: 'card_help',
    spec: CARD2_SPEC,
    components: CARD2_COMPONENTS.map(entry => ({ tag: entry.tag, kind: entry.kind, summary: entry.summary })),
    examples: [{ name: 'metrics-collapsible', description: 'Metric columns plus a collapsible detail panel; edit the native JSON and re-run card_check', card: METRICS_COLLAPSIBLE_EXAMPLE }],
  };
  if (options.component !== undefined) {
    const component = CARD2_COMPONENTS.find(entry => entry.tag === options.component);
    if (!component) {
      const known = CARD2_COMPONENTS.map(entry => entry.tag).join(', ');
      return { command: 'card_help', spec: CARD2_SPEC, components: [{ tag: 'unknown', kind: 'error', summary: `component "${options.component}" is not in this offline catalog; known: ${known}. This is a coverage boundary, not proof it is invalid.` }] };
    }
    return { command: 'card_help', spec: CARD2_SPEC, component };
  }
  if (options.query !== undefined) {
    const terms = options.query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = CARD2_COMPONENTS.filter(entry => {
      const haystack = [entry.tag, entry.kind, entry.summary, ...entry.keywords, ...entry.fields.map(field => field.name)].join(' ').toLowerCase();
      return terms.every(term => haystack.includes(term));
    });
    return {
      command: 'card_help',
      spec: CARD2_SPEC,
      components: matches.map(entry => ({ tag: entry.tag, kind: entry.kind, summary: entry.summary })),
      examples: base.examples,
    };
  }
  return base;
}

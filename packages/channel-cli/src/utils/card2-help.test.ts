/**
 * Tests for the offline Card JSON 2.0 catalog, validator and CLI surface.
 *
 * T-071 contract: local check only — no chat access, credentials, sends or
 * uploads — with stable diagnostic codes, JSON Pointers and an explicit
 * partial-coverage statement.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import {
  CARD2_SPEC,
  METRICS_COLLAPSIBLE_EXAMPLE,
  buildCard2Help,
  checkCard2,
} from './card2-help.js';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '../../../../skills/card-2/fixtures/metrics-collapsible.json');

async function capture(argv: string[]): Promise<{ code: number; writes: string[] }> {
  const writes: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { return { code: await run(argv), writes }; }
  finally { process.stdout.write = original; }
}

function clone<T>(value: T): T { return structuredClone(value); }

describe('Card JSON 2.0 offline catalog', () => {
  it('states snapshot provenance and explicit non-coverage', () => {
    expect(CARD2_SPEC.completeness).toBe('partial');
    expect(CARD2_SPEC.snapshotDate).toBe('2026-11-05');
    expect(CARD2_SPEC.sources.every(source => source.url.startsWith('https://open.feishu.cn/document/') && source.upstreamLastUpdated !== '')).toBe(true);
    expect(CARD2_SPEC.notCoveredRules.length).toBeGreaterThan(0);
  });

  it('indexes, searches and returns field-level help offline', () => {
    const index = buildCard2Help();
    expect(index.components?.map(entry => entry.tag)).toContain('collapsible_panel');
    expect(buildCard2Help({ query: 'fold' }).components?.map(entry => entry.tag)).toEqual(['collapsible_panel']);
    const panel = buildCard2Help({ component: 'collapsible_panel' }).component;
    expect(panel?.fields.find(field => field.name === 'expanded')?.type).toBe('boolean');
    expect(buildCard2Help({ component: 'chart' }).components?.[0].kind).toBe('error');
  });

  it('keeps the editable skill fixture identical to the CLI example', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
    expect(fixture).toEqual(METRICS_COLLAPSIBLE_EXAMPLE);
  });
});

describe('Card JSON 2.0 local check', () => {
  it('accepts the metrics-collapsible fixture as covered-subset valid', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
    const result = checkCard2(fixture);
    expect(result.valid).toBe(true);
    expect(result.spec.completeness).toBe('partial');
  });

  it('guides an agent from broken card to valid card using stable codes and pointers', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
    const broken = clone(fixture) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    const markdown = broken.body.elements[0] as unknown as { columns: Array<{ elements: Array<{ content?: unknown }> }> };
    markdown.columns[0].elements[0].content = 42;
    const panel = broken.body.elements[2] as { expanded: unknown };
    panel.expanded = 'yes';
    const columnSet = broken.body.elements[0] as { element_id: string };
    columnSet.element_id = 'detail_panel';

    const first = checkCard2(broken);
    expect(first.valid).toBe(false);
    const byPointer = new Map(first.diagnostics.map(issue => [issue.pointer, issue.code]));
    expect(byPointer.get('/body/elements/0/columns/0/elements/0/content')).toBe('CARD_FIELD_TYPE');
    expect(byPointer.get('/body/elements/2/expanded')).toBe('CARD_ENUM_INVALID');
    expect(byPointer.get('/body/elements/2/element_id')).toBe('CARD_ELEMENT_ID_DUPLICATE');
    expect(first.diagnostics.every(issue => issue.help.startsWith('disclaude channel card_help'))).toBe(true);

    // Agent applies exactly the feedback above, then re-checks.
    markdown.columns[0].elements[0].content = '**构建**\n通过';
    panel.expanded = false;
    columnSet.element_id = 'metrics_columns';
    expect(checkCard2(broken).valid).toBe(true);
  });

  it('reports enum, unknown-component, nesting and pipe-table defects at stable pointers', () => {
    const issues = checkCard2({
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: 'T' } },
      body: { elements: [
        { tag: 'collapsible_panel', header: {}, direction: 'diagonal', elements: [{ tag: 'chart_v2' }, { tag: 'markdown', content: '| A | B |\n|---|---|' }] },
      ] },
    }).diagnostics;
    const codes = new Map(issues.map(issue => [issue.pointer, issue.code]));
    expect(codes.get('/body/elements/0/direction')).toBe('CARD_ENUM_INVALID');
    expect(codes.get('/body/elements/0/elements/0/tag')).toBe('CARD_COMPONENT_NOT_IN_CATALOG');
    expect(codes.get('/body/elements/0/elements/1/content')).toBe('CARD_GFM_TABLE');
  });
});

describe('card_help / card_check CLI contract', () => {
  it('serves help offline with no fetch and no chat requirement', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    try {
      const { code, writes } = await capture(['card_help', '--query', '指标']);
      expect(code).toBe(0);
      const result = JSON.parse(writes[0]);
      expect(result).toMatchObject({ ok: true, command: 'card_help', offline: true, sideEffects: 'none' });
      expect(result.components.map((entry: { tag: string }) => entry.tag)).toContain('column_set');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { fetchMock.mockRestore(); }
  });

  it('returns exit 0/valid for the fixture and 1/issues for a broken card', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
    try {
      const ok = await capture(['card_check', '--card', JSON.stringify(fixture)]);
      expect(ok.code).toBe(0);
      expect(JSON.parse(ok.writes[0])).toMatchObject({ ok: true, valid: true, offline: true });
      const broken = clone(fixture) as { body: { elements: Array<Record<string, unknown>> } };
      (broken.body.elements[2] as { expanded: unknown }).expanded = 'yes';
      const fail = await capture(['card_check', '--card', JSON.stringify(broken)]);
      expect(fail.code).toBe(1);
      const result = JSON.parse(fail.writes[0]);
      expect(result).toMatchObject({ ok: false, valid: false, offline: true });
      expect(result.issues[0]).toMatchObject({ code: 'CARD_ENUM_INVALID', pointer: '/body/elements/2/expanded' });
      expect(result.spec.completeness).toBe('partial');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { fetchMock.mockRestore(); }
  });

  it('reports malformed JSON with the stable CARD_JSON_PARSE code', async () => {
    const { code, writes } = await capture(['card_check', '--card', '{']);
    expect(code).toBe(1);
    expect(JSON.parse(writes[0])).toMatchObject({ ok: false, valid: false, issues: [{ code: 'CARD_JSON_PARSE', pointer: '' }] });
  });
});

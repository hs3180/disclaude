import { describe, expect, it } from 'vitest';
import {
  ExtensionRegistrationError,
  ExtensionSection,
  type ExtensionRecord,
} from './registry.js';

interface Descriptor {
  readonly label: string;
}

function makeSection(): ExtensionSection<Descriptor> {
  return new ExtensionSection<Descriptor>('harness');
}

function seedBuiltin(section: ExtensionSection<Descriptor>): void {
  section.register('claude', { label: 'built-in claude' }, { source: 'builtin' });
  section.register('pi', { label: 'built-in pi' }, { source: 'builtin' });
}

describe('ExtensionSection.register', () => {
  it('registers and reads back a descriptor with defaulted external source', () => {
    const section = makeSection();
    const record = section.register('omh', { label: 'third-party' });
    expect(record.source).toBe('external');
    expect(record.kind).toBe('harness');
    expect(section.get('omh')).toEqual({ label: 'third-party' });
    expect(section.has('omh')).toBe(true);
    expect(section.size).toBe(1);
  });

  it('rejects duplicate ids unless override is explicit', () => {
    const section = makeSection();
    seedBuiltin(section);
    expect(() => section.register('claude', { label: 'replacement' })).toThrow(
      ExtensionRegistrationError
    );
    // 错误隔离:失败的注册不改变既有条目与其他条目
    expect(section.get('claude')).toEqual({ label: 'built-in claude' });
    expect(section.records().map((r) => r.source)).toEqual(['builtin', 'builtin']);

    section.register('claude', { label: 'replacement' }, { override: true });
    expect(section.get('claude')).toEqual({ label: 'replacement' });
    expect(section.records().find((r) => r.id === 'claude')?.source).toBe('external');
    // 覆盖保留插入位置(枚举顺序不变)
    expect(section.ids()).toEqual(['claude', 'pi']);
    expect(section.size).toBe(2);
  });

  it('validates ids and descriptors without touching existing entries', () => {
    const section = makeSection();
    seedBuiltin(section);
    for (const bad of ['', '   ', 'has space', 'a\tb']) {
      expect(() => section.register(bad, { label: 'x' })).toThrow(ExtensionRegistrationError);
    }
    expect(() => section.register('null-desc', undefined as unknown as Descriptor)).toThrow(
      ExtensionRegistrationError
    );
    expect(section.ids()).toEqual(['claude', 'pi']);
    expect(section.size).toBe(2);
  });
});

describe('ExtensionSection lookup and lifecycle', () => {
  it('require() throws with the available id list', () => {
    const section = makeSection();
    seedBuiltin(section);
    expect(() => section.require('codex')).toThrow(
      'Unknown harness extension: codex. Available: claude, pi'
    );
  });

  it('unregister removes exactly the named entry', () => {
    const section = makeSection();
    seedBuiltin(section);
    expect(section.unregister('claude')).toBe(true);
    expect(section.unregister('claude')).toBe(false);
    expect(section.has('claude')).toBe(false);
    expect(section.ids()).toEqual(['pi']);
  });

  it('iterates records and descriptors in registration order', () => {
    const section = makeSection();
    seedBuiltin(section);
    section.register('omh', { label: 'third-party' });
    const records: ExtensionRecord<Descriptor>[] = section.records();
    expect(records.map((r) => r.id)).toEqual(['claude', 'pi', 'omh']);
    expect([...section.descriptors()].map((d) => d.label)).toEqual([
      'built-in claude',
      'built-in pi',
      'third-party',
    ]);
  });
});

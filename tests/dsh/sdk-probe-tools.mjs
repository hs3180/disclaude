import { readFile } from 'node:fs/promises';
import { registerDshTools } from '../../packages/core/dist/sdk/providers/deepseek/tool-adapter.js';

// A DSH plugin uses the existing native tool adapter directly in the SDK-owned process.
export const name = 'disclaude-sdk-probe-tools';
export const inject = ['tools'];
export function apply(ctx, { material }) {
  let calls = 0;
  ctx.effect(() =>
    registerDshTools(ctx.tools, [
      {
        name: 'read_owned_material',
        description: 'Read the single owned diagnostic material.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: {
          type: 'object',
          properties: { fact: { type: 'string' } },
          required: ['fact'],
          additionalProperties: false,
        },
        execute: async (_input, { signal }) => {
          signal.throwIfAborted();
          if (++calls !== 1) throw new Error('Owned material can be read only once');
          return { fact: await readFile(material, 'utf8') };
        },
      },
    ])
  );
}

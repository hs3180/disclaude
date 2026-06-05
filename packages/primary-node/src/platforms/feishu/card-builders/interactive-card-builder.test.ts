/**
 * Tests for Interactive Card Builder.
 */

 

import { describe, it, expect } from 'vitest';
import {
  buildButton,
  buildMenu,
  buildDiv,
  buildMarkdown,
  buildDivider,
  buildActionGroup,
  buildCard,
  buildConfirmCard,
  buildSelectionCard,
  buildNote,
  buildColumnSet,
} from './interactive-card-builder.js';

describe('Interactive Card Builder', () => {
  describe('buildButton', () => {
    it('should build a default button', () => {
      const button = buildButton({ text: 'Click Me', value: 'click' });

      expect(button).toEqual({
        tag: 'button',
        text: { tag: 'plain_text', content: 'Click Me' },
        type: 'default',
        value: { action: 'click' },
      });
    });

    it('should build a primary button', () => {
      const button = buildButton({ text: 'Confirm', value: 'confirm', style: 'primary' });

      expect(button.type).toBe('primary');
    });

    it('should build a button with URL', () => {
      const button = buildButton({
        text: 'Open Link',
        value: 'link',
        url: 'https://example.com',
      });

      expect(button.url).toBe('https://example.com');
    });
  });

  describe('buildMenu', () => {
    it('should build a menu with options', () => {
      const menu = buildMenu({
        placeholder: 'Select...',
        value: 'select',
        options: [
          { text: 'Option A', value: 'a' },
          { text: 'Option B', value: 'b' },
        ],
      });

      expect(menu).toEqual({
        tag: 'select_static',
        placeholder: { tag: 'plain_text', content: 'Select...' },
        value: { action: 'select' },
        options: [
          { text: { tag: 'plain_text', content: 'Option A' }, value: 'a' },
          { text: { tag: 'plain_text', content: 'Option B' }, value: 'b' },
        ],
      });
    });
  });

  describe('buildDiv', () => {
    it('should build a div with markdown text', () => {
      const div = buildDiv('**Bold** text');

      expect(div).toEqual({
        tag: 'div',
        text: { tag: 'lark_md', content: '**Bold** text' },
      });
    });

    it('should build a div with plain text', () => {
      const div = buildDiv('Plain text', false);

      expect(div).toEqual({
        tag: 'div',
        text: { tag: 'plain_text', content: 'Plain text' },
      });
    });
  });

  describe('buildMarkdown', () => {
    it('should build a markdown element', () => {
      const md = buildMarkdown('# Heading');

      expect(md).toEqual({
        tag: 'markdown',
        content: '# Heading',
      });
    });

    it('should build a markdown element with alignment', () => {
      const md = buildMarkdown('Centered', 'center');

      expect(md).toEqual({
        tag: 'markdown',
        content: 'Centered',
        text_align: 'center',
      });
    });
  });

  describe('buildDivider', () => {
    it('should build a horizontal rule', () => {
      const hr = buildDivider();

      expect(hr).toEqual({ tag: 'hr' });
    });
  });

  describe('buildActionGroup', () => {
    it('should build an action group with buttons', () => {
      const action = buildActionGroup([
        buildButton({ text: 'Yes', value: 'yes', style: 'primary' }),
        buildButton({ text: 'No', value: 'no', style: 'danger' }),
      ]);

      expect(action).toEqual({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Yes' },
            type: 'primary',
            value: { action: 'yes' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'No' },
            type: 'danger',
            value: { action: 'no' },
          },
        ],
      });
    });
  });

  describe('buildCard', () => {
    it('should build a card with header and elements', () => {
      const card = buildCard({
        header: { title: 'Card Title', template: 'blue' },
        elements: [
          buildDiv('Card content'),
          buildActionGroup([
            buildButton({ text: 'OK', value: 'ok', style: 'primary' }),
          ]),
        ],
      });

      expect(card).toHaveProperty('config');
      expect(card).toHaveProperty('header');
      expect(card).toHaveProperty('elements');
      expect(card.header).toMatchObject({
        title: { tag: 'plain_text', content: 'Card Title' },
        template: 'blue',
      });
    });

    it('should build a card without header', () => {
      const card = buildCard({
        elements: [buildDiv('Content only')],
      });

      expect(card).not.toHaveProperty('header');
      expect(card).toHaveProperty('elements');
    });

    it('should build a card with subtitle', () => {
      const card = buildCard({
        header: { title: 'Title', subtitle: 'Subtitle' },
        elements: [],
      });

      expect(card.header).toBeDefined();
      expect(card.header).toHaveProperty('subtitle');
      expect(card.header!.subtitle).toEqual({
        tag: 'plain_text',
        content: 'Subtitle',
      });
    });
  });

  describe('buildConfirmCard', () => {
    it('should build a confirmation card', () => {
      const card = buildConfirmCard(
        'Confirm Action',
        'Are you sure?',
        'yes',
        'no'
      );

      expect(card.header!.title.content).toBe('Confirm Action');
      expect(card.elements).toHaveLength(2);
      expect(card.elements[0].tag).toBe('div');
      expect(card.elements[1].tag).toBe('action');
    });

    it('should use default values', () => {
      const card = buildConfirmCard('Confirm', 'Are you sure?');

      const actionGroup = card.elements[1] as unknown as { actions: { value: { action: string } }[] };
      expect(actionGroup.actions[0].value.action).toBe('confirm');
      expect(actionGroup.actions[1].value.action).toBe('cancel');
    });
  });

  describe('buildSelectionCard', () => {
    it('should build a selection card with menu', () => {
      const card = buildSelectionCard(
        'Choose Option',
        'Please select an option:',
        'Select...',
        'choose',
        [
          { text: 'Option A', value: 'a' },
          { text: 'Option B', value: 'b' },
        ]
      );

      expect(card.header!.title.content).toBe('Choose Option');
      expect(card.elements).toHaveLength(2);

      const actionGroup = card.elements[1] as unknown as { actions: { tag: string }[] };
      expect(actionGroup.actions[0].tag).toBe('select_static');
    });

    it('should use turquoise template for selection card', () => {
      const card = buildSelectionCard('Pick', 'Choose:', 'Select...', 'pick', []);
      expect(card.header!.template).toBe('turquoise');
    });

    it('should pass menu options correctly', () => {
      const options = [
        { text: 'Alpha', value: 'a' },
        { text: 'Beta', value: 'b' },
      ];
      const card = buildSelectionCard('Pick', 'Choose:', 'Select...', 'pick', options);

      const actionGroup = card.elements[1] as unknown as {
        actions: Array<{
          tag: string;
          options: Array<{ text: { tag: string; content: string }; value: string }>;
        }>;
      };
      const [menu] = actionGroup.actions;
      expect(menu.options).toEqual([
        { text: { tag: 'plain_text', content: 'Alpha' }, value: 'a' },
        { text: { tag: 'plain_text', content: 'Beta' }, value: 'b' },
      ]);
    });
  });

  describe('buildNote', () => {
    it('should build a note element with plain text', () => {
      const note = buildNote('Last updated 5 minutes ago');

      expect(note).toEqual({
        tag: 'note',
        elements: [
          { tag: 'plain_text', content: 'Last updated 5 minutes ago' },
        ],
      });
    });

    it('should build a note element with empty string', () => {
      const note = buildNote('');
      expect(note).toEqual({
        tag: 'note',
        elements: [{ tag: 'plain_text', content: '' }],
      });
    });
  });

  describe('buildColumnSet', () => {
    it('should build a column set with default vertical alignment', () => {
      const columns = buildColumnSet([
        { elements: [buildDiv('Left')] },
        { elements: [buildDiv('Right')] },
      ]);

      expect(columns).toEqual({
        tag: 'column_set',
        columns: [
          { width: undefined, vertical_align: 'center', elements: [buildDiv('Left')] },
          { width: undefined, vertical_align: 'center', elements: [buildDiv('Right')] },
        ],
      });
    });

    it('should build a column set with custom width and alignment', () => {
      const columns = buildColumnSet([
        { width: 3, verticalAlign: 'top', elements: [buildDiv('Narrow')] },
        { width: 6, verticalAlign: 'bottom', elements: [buildDiv('Wide')] },
      ]);

      expect(columns.tag).toBe('column_set');
      const cols = (columns as unknown as { columns: Array<{ width: number; vertical_align: string }> }).columns;
      expect(cols[0].width).toBe(3);
      expect(cols[0].vertical_align).toBe('top');
      expect(cols[1].width).toBe(6);
      expect(cols[1].vertical_align).toBe('bottom');
    });

    it('should handle empty columns array', () => {
      const columns = buildColumnSet([]);
      expect(columns).toEqual({ tag: 'column_set', columns: [] });
    });
  });

  describe('buildCard - header defaults', () => {
    it('should default header template to blue when not specified', () => {
      const card = buildCard({
        header: { title: 'My Card' },
        elements: [],
      });

      expect(card.header!.template).toBe('blue');
    });

    it('should not include subtitle when not provided', () => {
      const card = buildCard({
        header: { title: 'No Subtitle' },
        elements: [],
      });

      expect(card.header!.subtitle).toBeUndefined();
    });

    it('should always set wide_screen_mode to true', () => {
      const card = buildCard({ elements: [] });
      expect(card.config.wide_screen_mode).toBe(true);
    });
  });

  describe('buildButton - danger style', () => {
    it('should build a danger button', () => {
      const button = buildButton({ text: 'Delete', value: 'delete', style: 'danger' });
      expect(button.type).toBe('danger');
      expect(button.value).toEqual({ action: 'delete' });
    });

    it('should build a button without URL when not provided', () => {
      const button = buildButton({ text: 'Click', value: 'click' });
      expect(button.url).toBeUndefined();
    });
  });

  describe('buildConfirmCard - button styles', () => {
    it('should have primary confirm button and default cancel button', () => {
      const card = buildConfirmCard('Confirm', 'Sure?', 'yes_val', 'no_val');

      const actionGroup = card.elements[1] as unknown as {
        actions: Array<{ type: string; value: { action: string } }>;
      };
      expect(actionGroup.actions[0].type).toBe('primary');
      expect(actionGroup.actions[0].value.action).toBe('yes_val');
      expect(actionGroup.actions[1].type).toBe('default');
      expect(actionGroup.actions[1].value.action).toBe('no_val');
    });

    it('should use blue template', () => {
      const card = buildConfirmCard('Confirm', 'Sure?');
      expect(card.header!.template).toBe('blue');
    });
  });
});

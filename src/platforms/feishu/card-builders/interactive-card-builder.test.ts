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
  buildNote,
  buildCard,
  buildConfirmCard,
  buildSelectionCard,
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

      expect(card.header).toHaveProperty('subtitle');
      expect(card.header.subtitle).toEqual({
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

      expect(card.header.title.content).toBe('Confirm Action');
      expect(card.elements).toHaveLength(2);
      expect(card.elements[0].tag).toBe('div');
      expect(card.elements[1].tag).toBe('action');
    });

    it('should use default values', () => {
      const card = buildConfirmCard('Confirm', 'Are you sure?');

      const actionGroup = card.elements[1] as { actions: { value: { action: string } }[] };
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

      expect(card.header.title.content).toBe('Choose Option');
      expect(card.elements).toHaveLength(2);

      const actionGroup = card.elements[1] as { actions: { tag: string }[] };
      expect(actionGroup.actions[0].tag).toBe('select_static');
    });
  });
});

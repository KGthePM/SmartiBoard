import { describe, expect, it } from 'vitest';
import { parseBoard } from './graph';
import { buildTemplate, isTemplateId, TEMPLATE_IDS, TEMPLATES } from './templates';

describe('the template registry', () => {
  it('builds a complete, loadable board for every id it lists', () => {
    for (const id of TEMPLATE_IDS) {
      const board = TEMPLATES[id].build('b1');
      expect(board.id).toBe('b1');
      expect(board.title.trim().length).toBeGreaterThan(0);
      expect(board.nodes.length).toBeGreaterThan(0);
      // A template that degrades on its first save would be worse than none.
      const loaded = parseBoard('b1', JSON.parse(JSON.stringify(board)));
      expect(loaded.nodes).toHaveLength(board.nodes.length);
      expect(loaded.edges).toHaveLength(board.edges.length);
    }
  });

  it('gives every copy fresh ids, so two of the same template can coexist', () => {
    for (const id of TEMPLATE_IDS) {
      const a = TEMPLATES[id].build('b1');
      const b = TEMPLATES[id].build('b2');
      const ids = new Set(a.nodes.map((n) => n.id));
      expect(b.nodes.some((n) => ids.has(n.id))).toBe(false);
    }
  });

  it('never refuses: an unknown, absent or malformed name is simply not a template', () => {
    // The route reads null as "a blank board". Creating a board must not be
    // refusable, so nothing in here may throw on bad input.
    for (const junk of [undefined, null, '', 'kanBan', 'nope', 0, 1, true, {}, [], NaN]) {
      expect(buildTemplate(junk, 'b1')).toBe(null);
      expect(isTemplateId(junk)).toBe(false);
    }
  });

  it('builds the named board when the name is real', () => {
    for (const id of TEMPLATE_IDS) {
      expect(buildTemplate(id, 'b1')?.title).toBe(TEMPLATES[id].label);
      expect(isTemplateId(id)).toBe(true);
    }
  });
});

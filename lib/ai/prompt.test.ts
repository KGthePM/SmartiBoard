import { describe, expect, it } from 'vitest';
import { createNode, emptyBoard, type Board, type Edge } from '../graph';
import { serializeBoard, serializeBoardContent } from './prompt';

function board(texts: string[]): Board {
  const b = emptyBoard('t');
  b.nodes = texts.map((t, i) => createNode({ id: `n${i}`, x: 0, y: 0, text: t }));
  return b;
}

function edge(from: string, to: string, i: number): Edge {
  return { id: `e${i}`, from, to, layer: 'user' };
}

describe('serializeBoard', () => {
  it('never shows formatting markers to the model', () => {
    const out = serializeBoard(
      board(['**pricing** *risk*', '{{red|churn}}', 'plain ~~idea~~']),
      [],
    );
    expect(out).toContain('pricing risk');
    expect(out).toContain('churn');
    expect(out).toContain('plain idea');
    expect(out).not.toMatch(/\*\*|\{\{|~~|__/);
  });

  it('keeps anchors as ids so placement still works', () => {
    const out = serializeBoard(board(['a', 'b']), []);
    expect(out).toContain('- n0 [user]: a');
    expect(out).toContain('- n1 [user]: b');
  });

  it('tells the model which ideas are crossed off', () => {
    const b = board(['a', 'b']);
    b.nodes[1] = { ...b.nodes[1], done: true };
    const out = serializeBoard(b, []);
    expect(out).toContain('- n0 [user]: a');
    expect(out).toContain('- n1 [user, done]: b');
    expect(out).toContain('considers finished');
  });

  it('adds no done legend when nothing is crossed off', () => {
    const out = serializeBoard(board(['a', 'b']), []);
    expect(out).not.toContain('done');
  });

  it('never mentions reactions — they are the one mark the model does not see', () => {
    const b = board(['pricing', 'onboarding']);
    const plain = serializeBoard(b, []);
    b.nodes[0] = { ...b.nodes[0], reactions: ['love', 'fire', 'down'] };
    expect(serializeBoard(b, [])).toBe(plain);
  });

  it('lists dismissed suggestions for the model to avoid', () => {
    const out = serializeBoard(board(['a', 'b', 'c']), ['pricing tier']);
    expect(out).toContain('- pricing tier');
  });
});

describe('the objective in the prompt', () => {
  it('leads the board, so the model is framed before it sees an idea', () => {
    const b = { ...board(['pricing', 'churn']), objective: 'Win back churned design teams.' };
    const out = serializeBoard(b, []);
    expect(out).toContain("What this board is for, in the person's own words:");
    expect(out).toContain('Win back churned design teams.');
    expect(out.indexOf('Win back churned')).toBeLessThan(out.indexOf('Ideas on the board:'));
  });

  it('leaves no trace when unset — an empty header invites the model to fill it', () => {
    const out = serializeBoard(board(['pricing', 'churn']), []);
    expect(out).not.toContain('What this board is for');
    expect(out.startsWith('Ideas on the board:')).toBe(true);
  });

  it('is not treated as an idea: node ids still anchor proposals', () => {
    const b = { ...board(['pricing', 'churn']), objective: 'Win back churned teams.' };
    const out = serializeBoard(b, []);
    expect(out).toContain('- n0 [user]: pricing');
    expect(out).toContain('- n1 [user]: churn');
  });
});

describe('serializeBoardContent — folder-import scale (serializer-scale-plan)', () => {
  it('with no opts, renders a plain board byte-identically (the ghost regression guard)', () => {
    const b = board(['a', 'b']);
    b.edges = [edge('n0', 'n1', 0)];
    b.nodes[1] = { ...b.nodes[1], done: true };
    b.objective = 'Win back churned teams.';
    expect(serializeBoardContent(b)).toBe(
      [
        "What this board is for, in the person's own words:",
        'Win back churned teams.',
        '',
        'Ideas on the board:',
        '- n0 [user]: a',
        '- n1 [user, done]: b',
        '',
        'Nodes marked done are ideas the person considers finished — completed, not deleted.',
        '',
        'Existing connections:',
        '- a — b',
      ].join('\n'),
    );
  });

  it('collapses an embedded newline so one card is one list line, on nodes and edges alike', () => {
    const b = board(['page.tsx\nRenders the board and owns the undo stack.', 'ragged   \t spacing']);
    b.edges = [edge('n0', 'n1', 0)];
    const out = serializeBoardContent(b);
    const section = out.split('Ideas on the board:\n')[1].split('\n\n')[0];
    expect(section).toBe(
      '- n0 [user]: page.tsx Renders the board and owns the undo stack.\n' +
        '- n1 [user]: ragged spacing',
    );
    expect(out).toContain(
      '- page.tsx Renders the board and owns the undo stack. — ragged spacing',
    );
  });

  it('edgesById: every id on an edge line resolves against an id on a node line', () => {
    const b = board(['a', 'b', 'c']);
    b.edges = [edge('n0', 'n1', 0), edge('n1', 'n2', 1)];
    const out = serializeBoardContent(b, { edgesById: true });
    expect(out).toContain('- n0 — n1');
    expect(out).toContain('- n1 — n2');
    expect(out).not.toContain('- a — b');
    const nodeIds = new Set([...out.matchAll(/^- (n\d+) \[/gm)].map((m) => m[1]));
    for (const m of out.matchAll(/^- (n\d+) — (n\d+)$/gm)) {
      expect(nodeIds.has(m[1])).toBe(true);
      expect(nodeIds.has(m[2])).toBe(true);
    }
  });

  it('maxNodes keeps the first N substantive cards, prunes their edges, and says what was dropped', () => {
    const b = board(['a', 'b', 'c', '   ']);
    b.edges = [edge('n0', 'n1', 0), edge('n1', 'n2', 1), edge('n0', 'n3', 2)];
    const out = serializeBoardContent(b, { maxNodes: 2 });
    expect(out).toContain('- n0 [user]: a');
    expect(out).toContain('- n1 [user]: b');
    expect(out).not.toContain('[user]: c');
    expect(out).toContain('- a — b');
    expect(out).not.toContain('— c');
    expect(out).toContain('(1 more card not shown)');
  });

  it('maxNodes at or above the substantive count is a no-op — byte-identical, no disclosure line', () => {
    const b = board(['a', 'b']);
    b.edges = [edge('n0', 'n1', 0)];
    const plain = serializeBoardContent(b);
    expect(serializeBoardContent(b, { maxNodes: 2 })).toBe(plain);
    expect(serializeBoardContent(b, { maxNodes: 99 })).toBe(plain);
    expect(plain).not.toContain('not shown');
  });

  it('maxNodes of zero shows an empty board honestly rather than nothing at all', () => {
    const out = serializeBoardContent(board(['a', 'b']), { maxNodes: 0 });
    expect(out).toContain('Ideas on the board:\n(none)');
    expect(out).toContain('(2 more cards not shown)');
    expect(out).toContain('Existing connections:\n(none)');
  });

  it('the done legend follows the kept cards under truncation', () => {
    const b = board(['a', 'b']);
    b.nodes[1] = { ...b.nodes[1], done: true };
    expect(serializeBoardContent(b)).toContain('considers finished');
    expect(serializeBoardContent(b, { maxNodes: 1 })).not.toContain('considers finished');
  });

  it('a folder-shaped board: edges by text dominate the payload, by id they are a sliver', () => {
    // This repo's own ratios, scaled: 133 summarized file cards, 26 folders
    // plus a root, 159 tree edges, 114 import edges.
    const b = emptyBoard('repo map');
    b.objective = 'Understand this codebase.';
    const nodes = [createNode({ id: 'root', x: 0, y: 0, text: 'repo' })];
    const edges: Edge[] = [];
    const folderIds: string[] = [];
    for (let f = 0; f < 26; f += 1) {
      const id = `d${f}`;
      folderIds.push(id);
      nodes.push(createNode({ id, x: 0, y: 0, text: `folder${f}` }));
      edges.push({ id: `t${f}`, from: 'root', to: id, layer: 'user' });
    }
    const summary =
      'Sums the file up in one line so the model can reason about the codebase without opening it.';
    for (let file = 0; file < 133; file += 1) {
      const id = `n${file}`;
      nodes.push(createNode({ id, x: 0, y: 0, text: `file${file}.ts\n${summary}` }));
      edges.push({ id: `tf${file}`, from: folderIds[file % 26], to: id, layer: 'user' });
      if (file % 7 !== 3) {
        const j = (file * 11 + 5) % 133;
        if (j !== file) edges.push({ id: `i${file}`, from: id, to: `n${j}`, layer: 'user' });
      }
    }
    b.nodes = nodes;
    b.edges = edges;

    const byText = serializeBoardContent(b);
    const byId = serializeBoardContent(b, { edgesById: true });
    const edgeShare = (s: string) => {
      const i = s.indexOf('Existing connections:\n');
      return (s.length - i) / s.length;
    };
    expect(edgeShare(byText)).toBeGreaterThan(0.6);
    expect(edgeShare(byId)).toBeLessThan(0.2);
    expect(byText.length).toBeGreaterThan(byId.length * 2.5);
  });
});

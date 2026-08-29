import { describe, expect, it } from 'vitest';
import { createNode, emptyBoard, newId, type Board } from '../graph';
import {
  DEBOUNCE_MS,
  FAILURE_COOLDOWN_MS,
  fingerprint,
  shouldRequest,
  type TriggerState,
} from './trigger';

const NOW = 1_000_000;

function board(texts: string[]): Board {
  const b = emptyBoard('t');
  b.nodes = texts.map((t, i) => createNode({ id: `n${i}`, x: i * 220, y: 0, text: t }));
  return b;
}

const idle: TriggerState = {
  lastMutationAt: NOW - DEBOUNCE_MS - 1,
  lastRequestedFingerprint: null,
  liveProposals: 0,
  inFlight: false,
  failedAt: null,
};

describe('shouldRequest', () => {
  it('fires on a settled board with enough substance', () => {
    const d = shouldRequest(board(['pricing', 'onboarding', 'churn']), idle, NOW);
    expect(d.fire).toBe(true);
  });

  it('holds while the user is still typing', () => {
    const d = shouldRequest(board(['a', 'b', 'c']), { ...idle, lastMutationAt: NOW - 500 }, NOW);
    expect(d).toEqual({ fire: false, reason: 'debouncing' });
  });

  it('waits out the cooldown after a request that never answered', () => {
    // The fingerprint was released, so nothing else is holding this back —
    // without the cooldown the canvas would re-ask once a second.
    const d = shouldRequest(board(['a', 'b', 'c']), { ...idle, failedAt: NOW - 1000 }, NOW);
    expect(d).toEqual({ fire: false, reason: 'cooling_down' });
  });

  it('tries again once the cooldown is over', () => {
    const state = { ...idle, failedAt: NOW - FAILURE_COOLDOWN_MS - 1 };
    expect(shouldRequest(board(['a', 'b', 'c']), state, NOW).fire).toBe(true);
  });

  it('stays quiet below the node floor', () => {
    const d = shouldRequest(board(['a', 'b']), idle, NOW);
    expect(d).toEqual({ fire: false, reason: 'too_few_nodes' });
  });

  it('does not count empty placeholder nodes toward the floor', () => {
    const d = shouldRequest(board(['a', 'b', '   ']), idle, NOW);
    expect(d).toEqual({ fire: false, reason: 'too_few_nodes' });
  });

  it('does not count markers with no text underneath toward the floor', () => {
    const d = shouldRequest(board(['a', 'b', '****', '{{red|}}']), idle, NOW);
    expect(d).toEqual({ fire: false, reason: 'too_few_nodes' });
  });

  it('never puts a second ghost on the canvas', () => {
    const d = shouldRequest(board(['a', 'b', 'c']), { ...idle, liveProposals: 1 }, NOW);
    expect(d).toEqual({ fire: false, reason: 'proposal_limit' });
  });

  it('does not stack requests', () => {
    const d = shouldRequest(board(['a', 'b', 'c']), { ...idle, inFlight: true }, NOW);
    expect(d).toEqual({ fire: false, reason: 'in_flight' });
  });

  it('will not re-ask about a board it already asked about', () => {
    const b = board(['a', 'b', 'c']);
    const d = shouldRequest(b, { ...idle, lastRequestedFingerprint: fingerprint(b) }, NOW);
    expect(d).toEqual({ fire: false, reason: 'no_material_change' });
  });
});

describe('fingerprint', () => {
  it('ignores position — dragging is not thinking', () => {
    const a = board(['pricing', 'onboarding', 'churn']);
    const b = board(['pricing', 'onboarding', 'churn']);
    b.nodes = b.nodes.map((n) => ({ ...n, x: n.x + 999, y: n.y - 400 }));
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('ignores text formatting — emphasis is not a new idea', () => {
    const a = board(['pricing risk', 'onboarding', 'churn']);
    const b = board(['**pricing risk**', '*onboarding*', '{{red|churn}}']);
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('changes when an idea changes', () => {
    const a = board(['pricing', 'onboarding', 'churn']);
    const b = board(['pricing', 'onboarding', 'retention']);
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('changes when a connection is drawn', () => {
    const a = board(['a', 'b', 'c']);
    const b = board(['a', 'b', 'c']);
    b.edges = [{ id: newId('e'), from: 'n0', to: 'n1', layer: 'user' }];
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('is order-independent for the same graph', () => {
    const a = board(['a', 'b', 'c']);
    const b = board(['a', 'b', 'c']);
    b.nodes = [...b.nodes].reverse();
    expect(fingerprint(a)).toBe(fingerprint(b));
  });
});

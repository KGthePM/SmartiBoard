import { describe, expect, it } from 'vitest';
import { createNode, emptyBoard, newId, type Board } from '../graph';
import {
  canGenerateIdeas,
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

  it('ignores text size — a bigger card is not a bigger idea', () => {
    const a = board(['pricing', 'onboarding', 'churn']);
    const b = board(['pricing', 'onboarding', 'churn']);
    b.nodes = b.nodes.map((n) => ({ ...n, fontSize: 26 }));
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('changes when an idea changes', () => {
    const a = board(['pricing', 'onboarding', 'churn']);
    const b = board(['pricing', 'onboarding', 'retention']);
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('changes when an idea is crossed off — done is content the model sees', () => {
    const a = board(['a', 'b', 'c']);
    const b = board(['a', 'b', 'c']);
    b.nodes[0] = { ...b.nodes[0], done: true };
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

describe('fingerprint and the objective', () => {
  it('changes when the objective changes — the model sees a different board', () => {
    const a = board(['pricing', 'onboarding', 'churn']);
    const b = { ...a, objective: 'Win back churned design teams.' };
    expect(fingerprint(b)).not.toBe(fingerprint(a));
  });

  it('ignores whitespace around it, the way it ignores a drag', () => {
    const a = { ...board(['a', 'b', 'c']), objective: 'Win back churned teams.' };
    const b = { ...a, objective: '  Win back churned teams.\n' };
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it('does not stand in for ideas: an objective alone is not a board', () => {
    const b = { ...board(['pricing']), objective: 'Win back churned design teams.' };
    expect(shouldRequest(b, idle, NOW)).toEqual({ fire: false, reason: 'too_few_nodes' });
  });
});

describe('privacy mode', () => {
  it('says nothing about a private board, however ready it otherwise is', () => {
    const b = { ...board(['pricing', 'onboarding', 'churn']), privacy: true };
    expect(shouldRequest(b, idle, NOW)).toEqual({ fire: false, reason: 'privacy' });
  });

  it('outranks every other reason — it is the answer, not one of them', () => {
    // Deliberately also in flight, cooling down, and holding a live proposal:
    // whichever check ran first would block anyway, but the *reason* is the
    // point. Privacy is not the board being busy.
    const b = { ...board(['pricing', 'onboarding', 'churn']), privacy: true };
    const busy: TriggerState = {
      ...idle,
      inFlight: true,
      liveProposals: 1,
      failedAt: NOW - 1,
      lastMutationAt: NOW,
    };
    expect(shouldRequest(b, busy, NOW)).toEqual({ fire: false, reason: 'privacy' });
  });

  it('speaks again the moment it is turned off', () => {
    const b = { ...board(['pricing', 'onboarding', 'churn']), privacy: false };
    expect(shouldRequest(b, idle, NOW).fire).toBe(true);
  });

  it('is not content: toggling it does not change the fingerprint', () => {
    // If it did, turning privacy off would itself look like a new idea and
    // buy the ghost a free question about a board nobody had touched.
    const a = board(['pricing', 'onboarding', 'churn']);
    expect(fingerprint({ ...a, privacy: true })).toBe(fingerprint(a));
  });
});

describe('canGenerateIdeas', () => {
  it('refuses a board with nothing on it and nothing to aim at', () => {
    expect(canGenerateIdeas(emptyBoard('x'))).toBe(false);
  });

  it('runs on an objective alone — the cold start the ghost cannot serve', () => {
    // This is the whole reason it has its own floor: a fresh board with a
    // stated goal used to leave the entire AI layer silent.
    const b = { ...emptyBoard('x'), objective: 'Decide whether to launch in the EU first' };
    expect(canGenerateIdeas(b)).toBe(true);
  });

  it('runs on one idea, well below the ghost’s floor', () => {
    expect(canGenerateIdeas(board(['pricing']))).toBe(true);
  });

  it('does not count an empty card', () => {
    // Same substantiveNodes rule the ghost uses: a placeholder is not an idea.
    expect(canGenerateIdeas(board(['', '   ']))).toBe(false);
  });

  it('refuses a private board however much is on it', () => {
    const b = { ...board(['pricing', 'onboarding', 'churn']), privacy: true };
    expect(canGenerateIdeas(b)).toBe(false);
    expect(canGenerateIdeas({ ...b, objective: 'ship by Q3' })).toBe(false);
  });
});

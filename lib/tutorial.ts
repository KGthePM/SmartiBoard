/**
 * The tutorial board: onboarding as content, not chrome.
 *
 * A first-run user landed on an empty library and one sentence. The whole app's
 * help was a hover tip on a `?` nobody had a reason to hover. Rather than build
 * a coach-mark layer over the canvas — a state machine, a new panel, something
 * to dismiss — the tutorial is an ordinary board whose cards each teach one
 * gesture, positioned so reading them means performing the gesture: the resize
 * lesson is too small to show its own text, the connect lesson ships one
 * deliberately unlinked card, the create lesson has empty canvas beside it.
 *
 * It is an ordinary board in every other way — editable, archivable, deletable,
 * autosaving, counted in the index. Wrecking it is allowed and is half the
 * lesson; `seedIfEmpty` and the library's restore link put it back.
 *
 * No ghost is seeded here, and none can be: `Layer` is 'user' | 'accepted' and
 * a proposal is never a node. The board *describes* the ghost and *shows* the
 * accepted layer.
 *
 * Refreshed at v5.6 with lessons for everything shipped since the board was
 * born at v2.3 that lives *on* a board — Search & Replace, reactions, Ask, and
 * Share/live sync each get their own card, the same one-gesture-per-card
 * doctrine as the original set. Settings-level things with no board position
 * to teach from (themes, the Completed-cards fold, the Template library) get
 * a passing mention folded into an existing card instead of a card of their
 * own; install-level things (desktop, import/export, LAN) stay out entirely.
 *
 * Pure — no db, no DOM — so the seed path and the tests both import it.
 */

import { createNode, newId, type Board, type Edge, type IdeaNode } from './graph';

export const TUTORIAL_TITLE = 'Welcome to Smarti Board';

/**
 * The objective is not decoration: a non-empty one is what satisfies
 * `canGenerateIdeas`, so ⌘. is live on this board from the first second, which
 * is itself one of the lessons.
 */
export const TUTORIAL_OBJECTIVE =
  'Learn Smarti Board by using it — every card here is something to try.';

/**
 * A fresh copy each call, with fresh ids: two tutorial boards may coexist, so
 * nothing here may be a hardcoded id. Edges are wired from the local nodes.
 */
export function tutorialBoard(id: string): Board {
  const t = Date.now();
  let seq = 0;
  // Ordered createdAt, so the minimap and `deriveTitle` read the board in the
  // order it was written rather than in whatever order the clock ticked.
  const card = (partial: Partial<IdeaNode> & Pick<IdeaNode, 'x' | 'y'>): IdeaNode =>
    createNode({ ...partial, createdAt: t + seq++ });

  const welcome = card({
    x: 0,
    y: 0,
    w: 320,
    h: 110,
    fontSize: 21,
    text: '**Welcome.** This whole board is a tutorial, and you are meant to wreck it.',
  });

  const edit = card({
    x: 380,
    y: 0,
    w: 240,
    h: 110,
    text: 'Click me to edit my text. Drag me to move me. There is no save button — it saves as you go.',
  });

  const create = card({
    x: 680,
    y: 0,
    w: 240,
    h: 110,
    text: 'Double-click the empty space to my right to make a card of your own.',
  });

  const connectFrom = card({
    x: 0,
    y: 180,
    w: 240,
    h: 110,
    text: 'Every card has a dot on its edge. Drag mine onto the lonely card beside me.',
  });

  // The one card with no edges at all — the target of the lesson above.
  const connectTo = card({
    x: 320,
    y: 185,
    w: 200,
    h: 96,
    text: 'The lonely card. Nothing links me to anything.',
  });

  // Deliberately at the size floor with more text than it can show: the lesson
  // does not work if the card can be read without dragging it.
  const resize = card({
    x: 0,
    y: 370,
    w: 130,
    h: 52,
    text: 'Drag my bottom-right corner. I am too small to show my own text, which is the point — cards never grow on their own.',
  });

  const done = card({
    x: 300,
    y: 350,
    w: 240,
    h: 110,
    text: 'Select me and press **D** to cross me off.',
  });

  const alreadyDone = card({
    x: 600,
    y: 350,
    w: 280,
    h: 140,
    done: true,
    text: 'Like this. Crossed off, still on the board, still read by the AI. Fold cards like me down to a line or a dot in Settings → Completed cards.',
  });

  const accepted = card({
    x: 0,
    y: 500,
    w: 280,
    h: 140,
    layer: 'accepted',
    text: 'I am in the **accepted** layer — what an AI idea looks like once you take it. Your cards, its proposals, and accepted ideas never look alike.',
  });

  const ghost = card({
    x: 340,
    y: 520,
    w: 300,
    h: 150,
    text: 'The AI reads along and speaks unasked: one dashed **ghost** card at a time, accepted or dismissed in a click. Set a provider under the gear, or it never will.',
  });

  const ideas = card({
    x: 700,
    y: 520,
    w: 280,
    h: 140,
    text: 'Press **⌘.** to ask for candidates. They stream into a side panel and stay there — nothing reaches the board until you add it.',
  });

  const reactions = card({
    x: 0,
    y: 700,
    w: 260,
    h: 130,
    text: "Select me alone, then press **1**–**5** to react: ❤️ 🔥 ❗ 😂 👎. They're for you — the AI never sees them.",
  });

  // A deliberate plant: "wreck" already appears once in `welcome`'s text, so
  // searching for it here turns up exactly two hits.
  const search = card({
    x: 300,
    y: 700,
    w: 300,
    h: 130,
    text: 'Press **⌘F** and search for "wreck" — it\'s in two cards, this one included. Try Replace All.',
  });

  const ask = card({
    x: 660,
    y: 700,
    w: 320,
    h: 160,
    text: 'Press **⌘/** and ask something like "what\'s in the accepted layer?" — Ask answers only from what\'s on this board and cites the cards it used, but never writes back.',
  });

  const share = card({
    x: 0,
    y: 900,
    w: 320,
    h: 140,
    text: 'Press **Share** to hand this board to someone on your network. Open it in two tabs yourself first — edits, and the ghost, sync between them live.',
  });

  const chrome = card({
    x: 380,
    y: 900,
    w: 700,
    h: 170,
    text: '**⌘F** finds & replaces text · **⌘J** says what this board is for · **⌘⇧P** keeps it away from the AI entirely · **⌘Z** / **⌘⇧Z** undo and redo · **Home** starts a board of your own — or a Kanban, SWOT, or Mind map from its Template library · **⚙** Settings also holds themes and how long the ghost waits before speaking.',
  });

  const nodes = [
    welcome,
    edit,
    create,
    connectFrom,
    connectTo,
    resize,
    done,
    alreadyDone,
    accepted,
    ghost,
    ideas,
    reactions,
    search,
    ask,
    share,
    chrome,
  ];

  const edges: Edge[] = [
    edge(welcome, edit),
    edge(edit, create),
    edge(welcome, connectFrom),
    edge(connectFrom, resize),
    edge(resize, done),
    edge(done, alreadyDone),
    edge(resize, accepted),
    edge(accepted, ghost),
    edge(ghost, ideas),
    edge(ideas, reactions),
    edge(reactions, search),
    edge(search, ask),
    edge(ask, share),
    edge(share, chrome),
  ];

  return {
    id,
    title: TUTORIAL_TITLE,
    objective: TUTORIAL_OBJECTIVE,
    // Not private, deliberately: a ghost arriving on this board unasked is the
    // best demonstration the product has, and the card above says so.
    privacy: false,
    nodes,
    edges,
    updatedAt: t,
  };
}

function edge(from: IdeaNode, to: IdeaNode): Edge {
  return { id: newId('e'), from: from.id, to: to.id, layer: 'user' };
}

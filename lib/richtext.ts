/**
 * A deliberately small rich-text flavor, stored inline in node.text:
 *
 *   **bold**  *italic*  __underline__  ~~strike~~  {{red|colored}}
 *
 * Why inline markers instead of a parallel marks array with offsets: markers
 * travel with the text while editing, so nothing has to re-map ranges on every
 * keystroke. Why a plain textarea instead of contentEditable: the custom undo
 * stack and paste safety are not worth rebuilding around a browser HTML editor.
 *
 * Everything here is pure — no React, no DOM — so the AI paths (fingerprint,
 * prompt serialization) can strip markers without pulling in rendering.
 * Unmatched markers are literal text: `2 * 3` must never italicize.
 */

export const PALETTE = ['red', 'amber', 'green', 'blue', 'violet'] as const;
export type ColorKey = (typeof PALETTE)[number];

const COLOR_OPEN = new RegExp(`^\\{\\{(${PALETTE.join('|')})\\|`);

export type Segment = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: ColorKey;
};

/** The styling half of a Segment, without the text it applies to. */
type Marks = Omit<Segment, 'text'>;

type MarkerKind = 'bold' | 'italic' | 'underline' | 'strike' | 'color-open' | 'color-close';

type Token =
  | { kind: 'text'; text: string }
  | { kind: MarkerKind; src: string; color?: ColorKey };

const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let buf = '';
  let i = 0;

  const flush = () => {
    if (buf) {
      tokens.push({ kind: 'text', text: buf });
      buf = '';
    }
  };

  while (i < src.length) {
    const rest = src.slice(i);
    const color = COLOR_OPEN.exec(rest);
    if (color) {
      flush();
      tokens.push({ kind: 'color-open', src: color[0], color: color[1] as ColorKey });
      i += color[0].length;
      continue;
    }
    if (rest.startsWith('}}')) {
      flush();
      tokens.push({ kind: 'color-close', src: '}}' });
      i += 2;
      continue;
    }
    if (rest.startsWith('**')) {
      flush();
      tokens.push({ kind: 'bold', src: '**' });
      i += 2;
      continue;
    }
    if (rest.startsWith('__')) {
      flush();
      tokens.push({ kind: 'underline', src: '__' });
      i += 2;
      continue;
    }
    if (rest.startsWith('~~')) {
      flush();
      tokens.push({ kind: 'strike', src: '~~' });
      i += 2;
      continue;
    }
    if (src[i] === '*') {
      // A single star not consumed by the ** branch above.
      flush();
      tokens.push({ kind: 'italic', src: '*' });
      i += 1;
      continue;
    }
    buf += src[i];
    i += 1;
  }
  flush();
  return tokens;
}

/**
 * Pairs openers with closers, LIFO, markdown-style. Emphasis tokens double as
 * open and close; the whitespace flanking rules are what keep `3 * 4 * 5`
 * literal. Openers abandoned above a matched pair stay unmatched (literal).
 */
function pairMarkers(tokens: Token[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];

  for (let idx = 0; idx < tokens.length; idx += 1) {
    const t = tokens[idx];
    if (t.kind === 'text') continue;

    const prev = tokens[idx - 1];
    const next = tokens[idx + 1];
    const prevChar = prev?.kind === 'text' ? prev.text.at(-1) : undefined;
    const nextChar = next?.kind === 'text' ? next.text[0] : undefined;
    const canOpen = !isSpace(nextChar);
    const canClose = !isSpace(prevChar);

    if (t.kind === 'color-close') {
      if (!canClose) continue;
      for (let d = stack.length - 1; d >= 0; d -= 1) {
        if (tokens[stack[d]].kind === 'color-open') {
          const opener = stack[d];
          stack.length = d;
          pairs.set(opener, idx);
          break;
        }
      }
      continue;
    }

    if (canClose) {
      let match = -1;
      for (let d = stack.length - 1; d >= 0; d -= 1) {
        if (tokens[stack[d]].kind === t.kind) {
          match = d;
          break;
        }
      }
      if (match >= 0) {
        const opener = stack[match];
        stack.length = match;
        pairs.set(opener, idx);
        continue;
      }
    }
    if (canOpen) stack.push(idx);
  }

  return pairs;
}

function sameMarks(a: Marks, b: Marks): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.color === b.color
  );
}

/** Parses text into styled segments. Output feeds React spans, never innerHTML. */
export function parseRichText(text: string): Segment[] {
  const tokens = tokenize(text);
  const pairs = pairMarkers(tokens);
  const closers = new Set(pairs.values());

  const segments: Segment[] = [];
  const open: Marks[] = [];

  const emit = (chunk: string) => {
    if (!chunk) return;
    const marks: Marks = {};
    for (const m of open) {
      if (m.bold) marks.bold = true;
      if (m.italic) marks.italic = true;
      if (m.underline) marks.underline = true;
      if (m.strike) marks.strike = true;
      if (m.color) marks.color = m.color;
    }
    const last = segments.at(-1);
    if (last && sameMarks(last, marks)) {
      last.text += chunk;
    } else {
      segments.push({ text: chunk, ...marks });
    }
  };

  tokens.forEach((t, idx) => {
    if (t.kind === 'text') {
      emit(t.text);
    } else if (closers.has(idx)) {
      open.pop();
    } else if (pairs.has(idx)) {
      if (t.kind === 'bold') open.push({ bold: true });
      else if (t.kind === 'italic') open.push({ italic: true });
      else if (t.kind === 'underline') open.push({ underline: true });
      else if (t.kind === 'strike') open.push({ strike: true });
      else if (t.kind === 'color-open' && t.color) open.push({ color: t.color });
    } else {
      emit(t.src);
    }
  });

  return segments;
}

/** Plain text with matched markers removed — what the AI is allowed to see. */
export function stripMarks(text: string): string {
  const tokens = tokenize(text);
  const pairs = pairMarkers(tokens);
  const closers = new Set(pairs.values());

  let out = '';
  tokens.forEach((t, idx) => {
    if (t.kind === 'text') out += t.text;
    else if (!pairs.has(idx) && !closers.has(idx)) out += t.src;
  });
  return out;
}

export type Edit = { text: string; start: number; end: number };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function coreSelection(text: string, start: number, end: number) {
  const sel = text.slice(start, end);
  const lead = /^\s*/.exec(sel)![0];
  const trail = /\s*$/.exec(sel)![0];
  return { a: start + lead.length, b: end - trail.length };
}

/**
 * Toggles one of the simple marks around the selection. Whitespace at the
 * edges of the selection stays outside the markers — `**word **` would not
 * re-parse as bold, so we never produce it.
 */
export function toggleWrap(text: string, start: number, end: number, open: string, close: string): Edit {
  const { a, b } = coreSelection(text, start, end);
  const sel = text.slice(a, b);
  if (!sel) return { text, start, end };

  const wrapped = new RegExp(`^${escapeRegExp(open)}([\\s\\S]*)${escapeRegExp(close)}$`).exec(sel);
  if (wrapped) {
    const inner = wrapped[1];
    return {
      text: text.slice(0, a) + inner + text.slice(b),
      start: a,
      end: a + inner.length,
    };
  }

  // Markers sitting immediately around the selection: remove them. Skipped
  // for single-char markers, where `*` hugging `**` is ambiguous.
  if (
    open.length > 1 &&
    a >= open.length &&
    b + close.length <= text.length &&
    text.slice(a - open.length, a) === open &&
    text.slice(b, b + close.length) === close
  ) {
    return {
      text: text.slice(0, a - open.length) + text.slice(a, b) + text.slice(b + close.length),
      start: a - open.length,
      end: b - open.length,
    };
  }

  return {
    text: text.slice(0, a) + open + sel + close + text.slice(b),
    start: a,
    end: a + open.length + sel.length + close.length,
  };
}

const OPEN_SUFFIX = new RegExp(`\\{\\{(${PALETTE.join('|')})\\|$`);
const WRAPPED_COLOR = new RegExp(`^\\{\\{(${PALETTE.join('|')})\\|([\\s\\S]*)\\}\\}$`);

/**
 * Drops color markers that pair up entirely inside the selection. Colors are
 * exclusive — the innermost one wins on render — so wrapping a new color
 * around old ones nests dead markers (`{{green|a {{amber|b}} b}}`). Emphasis
 * markers are left alone: bold inside a color is meaningful. Markers split by
 * the selection boundary stay literal.
 */
function flattenInnerColors(sel: string): string {
  const tokens = tokenize(sel);
  const pairs = pairMarkers(tokens);
  const closers = new Set(pairs.values());

  let out = '';
  tokens.forEach((t, idx) => {
    const isColor = t.kind === 'color-open' || t.kind === 'color-close';
    if (isColor && (pairs.has(idx) || closers.has(idx))) return;
    out += t.kind === 'text' ? t.text : t.src;
  });
  return out;
}

/**
 * Toggles a palette color: wraps, unwraps the same color, or swaps a
 * different color that already wraps the selection.
 */
export function toggleColor(text: string, start: number, end: number, color: ColorKey): Edit {
  const { a, b } = coreSelection(text, start, end);
  const sel = text.slice(a, b);
  if (!sel) return { text, start, end };

  const before = text.slice(0, a);
  const adjacent = OPEN_SUFFIX.exec(before);
  if (adjacent && text.slice(b, b + 2) === '}}') {
    const oldOpen = adjacent[0];
    if (adjacent[1] === color) {
      return {
        text: before.slice(0, before.length - oldOpen.length) + sel + text.slice(b + 2),
        start: a - oldOpen.length,
        end: b - oldOpen.length,
      };
    }
    const newOpen = `{{${color}|`;
    const flat = flattenInnerColors(sel);
    return {
      text: before.slice(0, before.length - oldOpen.length) + newOpen + flat + '}}' + text.slice(b + 2),
      start: a - oldOpen.length,
      end: a - oldOpen.length + newOpen.length + flat.length + 2,
    };
  }

  const wrapped = WRAPPED_COLOR.exec(sel);
  if (wrapped) {
    const [, key, inner] = wrapped;
    if (key === color) {
      return {
        text: text.slice(0, a) + inner + text.slice(b),
        start: a,
        end: a + inner.length,
      };
    }
    const newOpen = `{{${color}|`;
    const flat = flattenInnerColors(inner);
    return {
      text: text.slice(0, a) + newOpen + flat + '}}' + text.slice(b),
      start: a,
      end: a + newOpen.length + flat.length + 2,
    };
  }

  const open = `{{${color}|`;
  const flat = flattenInnerColors(sel);
  return {
    text: text.slice(0, a) + open + flat + '}}' + text.slice(b),
    start: a,
    end: a + open.length + flat.length + 2,
  };
}

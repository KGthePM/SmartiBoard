import { describe, expect, it } from 'vitest';
import { parseShareToken, shareUrl } from './share';

describe('shareUrl', () => {
  it('points at the board page the app already has, not a second route', () => {
    expect(shareUrl('http://192.168.1.20:3000', 'b1', 'tok')).toBe(
      'http://192.168.1.20:3000/board/b1#s=tok',
    );
  });

  it('keeps the token in the fragment, which no server ever receives', () => {
    const url = new URL(shareUrl('http://host:3000', 'b1', 'tok'));
    expect(url.pathname).toBe('/board/b1');
    expect(url.search).toBe('');
    expect(url.hash).toBe('#s=tok');
  });

  it('tolerates a trailing slash, so location.origin and a typed string agree', () => {
    expect(shareUrl('http://host:3000/', 'b1', 'tok')).toBe(shareUrl('http://host:3000', 'b1', 'tok'));
  });

  it('escapes both halves, so an id or token can never break the link', () => {
    const url = shareUrl('http://host:3000', 'a b#c', 'x&y=z');
    expect(parseShareToken(new URL(url).hash)).toBe('x&y=z');
    expect(new URL(url).pathname).toBe('/board/a%20b%23c');
  });
});

describe('parseShareToken', () => {
  it('reads the token back out of a link it wrote', () => {
    expect(parseShareToken(new URL(shareUrl('http://h:1', 'b', 'tok')).hash)).toBe('tok');
  });

  it('accepts a fragment with or without its leading hash', () => {
    expect(parseShareToken('#s=tok')).toBe('tok');
    expect(parseShareToken('s=tok')).toBe('tok');
  });

  // Total and tolerant, like parseBoard: a malformed link is somebody with no
  // access, which the gate answers — never a crash on the page saying so.
  it('says nothing about a link that carries no token', () => {
    expect(parseShareToken('')).toBeNull();
    expect(parseShareToken('#')).toBeNull();
    expect(parseShareToken('#s=')).toBeNull();
    expect(parseShareToken('#nonsense')).toBeNull();
    expect(parseShareToken('#card=n1')).toBeNull();
    expect(parseShareToken('#ss=tok')).toBeNull();
  });

  it('finds the token beside other keys, so a later fragment breaks no old link', () => {
    expect(parseShareToken('#card=n1&s=tok')).toBe('tok');
    expect(parseShareToken('#s=tok&card=n1')).toBe('tok');
  });

  it('refuses a token that will not decode rather than throwing', () => {
    expect(parseShareToken('#s=%E0%A4%A')).toBeNull();
  });

  it('is null for anything that is not a string', () => {
    expect(parseShareToken(undefined as unknown as string)).toBeNull();
    expect(parseShareToken(null as unknown as string)).toBeNull();
  });
});

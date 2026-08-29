'use client';

import { useMemo } from 'react';
import { parseRichText, type Segment } from '@/lib/richtext';
import { markMatches, type Match } from '@/lib/search';

export function markClasses(s: Segment & { hit?: 'on' | 'active' }): string {
  return [
    s.bold && 'rt-b',
    s.italic && 'rt-i',
    s.underline && 'rt-u',
    s.strike && 'rt-s',
    s.color && `rt-c-${s.color}`,
    s.hit && (s.hit === 'active' ? 'find active' : 'find'),
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The read view. Segments become React spans — never innerHTML — so stored
 * text can never inject markup. Search hits split those segments further; the
 * split is exact because the segments of a parse concatenate back to the
 * stripped text the offsets index into.
 *
 * Shared by the canvas card and the print sheet: both render the same read
 * view from the same stored markers, so paper and screen can never disagree
 * about what a card says.
 */
export function RichTextView({
  text,
  matches,
  activeMatch,
}: {
  text: string;
  matches: Match[];
  activeMatch: number | null;
}) {
  const segments = useMemo(
    () => markMatches(parseRichText(text), matches, activeMatch),
    [text, matches, activeMatch],
  );
  if (segments.length === 0) return null;
  return (
    <>
      {segments.map((s, i) => (
        <span key={i} className={markClasses(s)}>
          {s.text}
        </span>
      ))}
    </>
  );
}

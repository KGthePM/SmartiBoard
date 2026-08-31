/**
 * The three layers, in miniature — and on the tokens, not on copies of
 * them, so the mark follows the theme the boards below it use. One source
 * for both places the page shows it: the header (large) and the footer
 * (small), via `size`.
 */
export function IndexMark({ size, className }: { size: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 22 22" aria-hidden="true">
      <rect
        x="1.5"
        y="7"
        width="11"
        height="9"
        rx="2"
        fill="var(--user-bg)"
        stroke="var(--user-border)"
      />
      <rect
        x="8.5"
        y="3.5"
        width="11"
        height="9"
        rx="2"
        fill="var(--ghost-bg)"
        stroke="var(--ghost-border)"
        strokeDasharray="2.5 2"
      />
      <rect
        x="5"
        y="10.5"
        width="11"
        height="9"
        rx="2"
        fill="var(--accepted-bg)"
        stroke="var(--accepted-border)"
      />
      <circle cx="8.2" cy="13.7" r="1.3" fill="var(--accepted-mark)" />
    </svg>
  );
}

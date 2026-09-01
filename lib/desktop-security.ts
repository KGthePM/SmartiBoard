import { timingSafeEqual } from 'node:crypto';

/**
 * The desktop server is still HTTP, but it belongs to one Electron window.
 * Both values are random/runtime-only and the web edition supplies neither,
 * so the same Next build remains openly self-hostable when launched normally.
 */
export function authorizeDesktopRequest(input: {
  requiredToken?: string;
  requiredHost?: string;
  suppliedToken: string | null;
  suppliedHost: string | null;
}): boolean {
  const required = input.requiredToken?.trim();
  if (!required) return true;
  if (!input.suppliedToken || input.suppliedHost !== input.requiredHost) return false;

  const expected = Buffer.from(required);
  const actual = Buffer.from(input.suppliedToken);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

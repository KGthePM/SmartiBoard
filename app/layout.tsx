import type { Metadata } from 'next';
import { Cinzel } from 'next/font/google';
import { loadSettings } from '@/lib/db';
import { DEFAULT_THEME } from '@/lib/theme';
import './globals.css';

// next/font bakes the files into the build output; the running app never
// fetches a font, so an offline deployment stays offline.
const cinzel = Cinzel({
  subsets: ['latin'],
  weight: ['400', '600'],
  variable: '--font-cinzel',
  display: 'swap',
});

// The theme is read out of the SQLite file on every request and stamped on
// <html> before a byte is sent, so a dark install never flashes light while a
// client-side fetch resolves. This costs nothing here: the app is a single
// local process over a file it already opens, and the index page is
// force-dynamic for the same reason.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Smarti Board',
  description: 'A smarter board for the way you think.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // No row yet — a fresh install that has never opened Settings — is Light.
  const theme = loadSettings()?.theme ?? DEFAULT_THEME;
  return (
    <html lang="en" className={cinzel.variable} data-theme={theme}>
      <body>{children}</body>
    </html>
  );
}

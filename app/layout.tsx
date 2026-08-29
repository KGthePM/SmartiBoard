import type { Metadata } from 'next';
import { Cinzel } from 'next/font/google';
import './globals.css';

// next/font bakes the files into the build output; the running app never
// fetches a font, so an offline deployment stays offline.
const cinzel = Cinzel({
  subsets: ['latin'],
  weight: ['400', '600'],
  variable: '--font-cinzel',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Smarti Board',
  description: 'An idea board that thinks with you.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cinzel.variable}>
      <body>{children}</body>
    </html>
  );
}

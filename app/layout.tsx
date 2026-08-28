import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Smarti Board',
  description: 'An idea board that thinks with you.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

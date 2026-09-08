import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { AuthProvider } from '../lib/auth';
import Shell from '../components/Shell';

/**
 * Inter, self-hosted by next/font.
 *
 * The default system stack renders differently on every machine, which is most
 * of why an interface can look unfinished without anything being wrong. Inter
 * was drawn for screens and for dense numeric tables - which is the whole of
 * this product.
 *
 * next/font downloads it at build time and serves it from our own origin, so
 * there is no request to Google at runtime and no flash of unstyled text.
 */
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
  // 400 body, 500 labels, 600 headings, 700 figures. Nothing heavier: bold
  // everywhere reads as shouting.
  weight: ['400', '500', '600', '700'],
});

export const metadata: Metadata = {
  title: 'Munim — Tally on your phone',
  description: 'Your Tally books, live. Sales, receivables and payment reminders.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="bg-canvas text-ink antialiased">
        <AuthProvider>
          <Shell>{children}</Shell>
        </AuthProvider>
      </body>
    </html>
  );
}

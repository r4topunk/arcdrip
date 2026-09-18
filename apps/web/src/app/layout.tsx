import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

// Self-hosted at build time by next/font: no request to Google from the visitor's browser.
const sans = Geist({ subsets: ['latin'], variable: '--font-geist', display: 'swap' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });

const description =
  'A shared USDC stream for collectives on Arc: one rate, N shares, live runway. Join, leave or re-weight mid-stream in one write.';

export const metadata: Metadata = {
  title: { default: 'ArcDrip: collective payroll on Arc', template: '%s · ArcDrip' },
  description,
  applicationName: 'ArcDrip',
  openGraph: {
    type: 'website',
    siteName: 'ArcDrip',
    title: 'ArcDrip: collective payroll on Arc',
    description,
  },
};

export const viewport: Viewport = { themeColor: '#ffffff', colorScheme: 'light' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-dvh overflow-x-clip antialiased">
        <main id="main">{children}</main>
      </body>
    </html>
  );
}

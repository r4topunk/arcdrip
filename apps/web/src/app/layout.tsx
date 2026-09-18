import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { config } from '@/lib/config';
import './globals.css';

// Self-hosted at build time by next/font: no request to Google from the visitor's browser.
const sans = Geist({ subsets: ['latin'], variable: '--font-geist', display: 'swap' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });

const description =
  'A shared USDC stream for collectives on Arc: one rate, N shares, live runway. Join, leave or re-weight mid-stream in one write.';

export const metadata: Metadata = {
  metadataBase: new URL(`${config.siteUrl}/`),
  title: { default: 'SharedArc: collective payroll on Arc', template: '%s · SharedArc' },
  description,
  applicationName: 'SharedArc',
  openGraph: {
    type: 'website',
    siteName: 'SharedArc',
    title: 'SharedArc: collective payroll on Arc',
    description,
  },
};

export const viewport: Viewport = { themeColor: '#ffffff', colorScheme: 'light' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-dvh overflow-x-clip antialiased">
        <Providers>
          <SiteHeader />
          <main id="main">{children}</main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}

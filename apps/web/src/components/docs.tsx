'use client';

import type { Locale } from '@/lib/i18n';
import { PageHeader } from './app-states';
import { useDocumentTitle, useI18n } from './i18n';

/** What the server passes to the client per locale (plain JSON: no fs, no marked in the bundle). */
export interface DocView {
  translated: boolean;
  title: string;
  html: string;
  headings: { id: string; text: string; depth: number }[];
  file: string;
}

export function DocsPage({ docs }: { docs: Record<Locale, DocView> }) {
  const { t, locale } = useI18n();
  const doc = docs[locale];
  useDocumentTitle(doc.title);
  const toc = doc.headings.filter((h) => h.depth === 2);
  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_200px]">
      <div className="flex min-w-0 flex-col gap-8">
        <PageHeader eyebrow={t('docs.eyebrow')} title={doc.title} />
        {/* Rendered at build time from a file in this repository; nothing here comes from the network. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: build-time markdown from apps/web/content */}
        <article className="prose" dangerouslySetInnerHTML={{ __html: doc.html }} />
      </div>
      <aside className="order-first lg:sticky lg:top-20 lg:order-none lg:self-start">
        <p className="eyebrow mb-2">{t('docs.onThisPage')}</p>
        <nav aria-label={t('docs.onThisPage')} className="flex flex-col gap-1.5 text-sm">
          {toc.map((h) => (
            <a key={h.id} href={`#${h.id}`} className="text-muted hover:text-foreground">
              {h.text}
            </a>
          ))}
        </nav>
      </aside>
    </div>
  );
}

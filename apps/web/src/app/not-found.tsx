'use client';

import Link from 'next/link';
import { useDocumentTitle, useI18n } from '@/components/i18n';

/** GitHub Pages serves this for any bad link, including links from the PT-BR docs, so it follows the language toggle. */
export default function NotFound() {
  const { t } = useI18n();
  useDocumentTitle(t('notFound.title'));
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-24 sm:px-6">
      <span className="kicker">404</span>
      <h1 className="font-semibold text-3xl tracking-tight">{t('notFound.title')}</h1>
      <p className="text-muted">{t('notFound.body')}</p>
      <Link href="/" className="w-fit text-accent underline underline-offset-4">
        {t('nav.pools')}
      </Link>
    </div>
  );
}

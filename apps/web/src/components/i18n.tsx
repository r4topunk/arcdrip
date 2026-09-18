'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { DEFAULT_LOCALE, LOCALES, type Locale, type MessageKey, translate, type Vars } from '@/lib/i18n';
import { safeGet, safeSet } from '@/lib/storage';
import { cn } from '@/lib/utils';

/**
 * Shared with the project page (site/index.html), which stores 'en' or 'pt' under the same key, so the language
 * picked on either page carries over on the same origin.
 */
export const LOCALE_STORAGE_KEY = 'sharedarc:lang';

export function readStoredLocale(): Locale {
  const v = safeGet(LOCALE_STORAGE_KEY);
  if (v === 'pt' || v === 'pt-BR') return 'pt-BR';
  return DEFAULT_LOCALE;
}

interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: MessageKey, vars?: Vars) => string;
}

const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: (key, vars) => translate(DEFAULT_LOCALE, key, vars),
});

export function I18nProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: Locale }) {
  // The static HTML is English; the stored choice is applied after mount, so hydration always matches.
  const [locale, setLocaleState] = useState<Locale>(initialLocale ?? DEFAULT_LOCALE);

  useEffect(() => {
    if (!initialLocale) setLocaleState(readStoredLocale());
  }, [initialLocale]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    safeSet(LOCALE_STORAGE_KEY, l === 'pt-BR' ? 'pt' : 'en');
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, t: (key, vars) => translate(locale, key, vars) }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

/**
 * Sets the browser tab title to "<title> · SharedArc" in the active language. Route metadata is static and English (the
 * export is built once), so each view calls this with its translated title; null leaves the title alone.
 */
export function useDocumentTitle(title: string | null) {
  useEffect(() => {
    if (title) document.title = `${title} · SharedArc`;
  }, [title]);
}

/** EN / PT-BR segmented toggle; the pressed state is announced. */
export function LocaleToggle({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a button group, like the project page's toggle
    <div
      role="group"
      aria-label={t('locale.label')}
      className={cn('inline-flex gap-0.5 rounded-lg bg-surface-2 p-0.5', className)}
    >
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={locale === l}
          onClick={() => setLocale(l)}
          className={cn(
            'cursor-pointer whitespace-nowrap rounded-md px-2.5 py-1 font-medium text-xs transition-colors',
            locale === l ? 'bg-surface text-foreground shadow-sm' : 'text-muted hover:text-foreground',
          )}
        >
          {t(`locale.${l}`)}
        </button>
      ))}
    </div>
  );
}

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY, LocaleToggle, readStoredLocale, useI18n } from '@/components/i18n';
import { MESSAGES, type MessageKey, translate } from '@/lib/i18n';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('dictionaries', () => {
  it('has every English key in Portuguese, and no extra ones', () => {
    expect(Object.keys(MESSAGES['pt-BR']).sort()).toEqual(Object.keys(MESSAGES.en).sort());
  });

  it('has no empty strings and the same placeholders in both languages', () => {
    for (const key of Object.keys(MESSAGES.en) as MessageKey[]) {
      // `table.actions` is a deliberately empty header label for a column of buttons.
      if (key !== 'table.actions') {
        expect(MESSAGES.en[key].trim(), key).not.toBe('');
        expect(MESSAGES['pt-BR'][key].trim(), key).not.toBe('');
      }
      expect(placeholders(MESSAGES['pt-BR'][key]), key).toEqual(placeholders(MESSAGES.en[key]));
    }
  });

  it('never promises members a return, a yield or a reward (PRD 2.3)', () => {
    const text = (s: string) => s.replace(/\{\w+\}/g, '');
    for (const key of Object.keys(MESSAGES.en) as MessageKey[]) {
      // "no yield" in the non-goals line is the claim itself, not a promise.
      if (key === 'footer.tagline' || key === 'footer.nonGoals') continue;
      expect(text(MESSAGES.en[key]), key).not.toMatch(/\b(yield|apy|interest|reward|rewards|profit)\b/i);
      expect(text(MESSAGES['pt-BR'][key]), key).not.toMatch(/rendimento|recompensa|lucro|juros/i);
    }
  });

  it('fills placeholders and leaves unknown ones as written', () => {
    expect(translate('en', 'pool.eyebrow', { id: 7 })).toBe('Pool #7');
    expect(translate('pt-BR', 'pool.eyebrow', { id: 7n })).toBe('Pool #7');
    expect(translate('en', 'pool.eyebrow')).toBe('Pool #{id}');
    expect(translate('en', 'pool.notFound', { id: 3 })).toContain('#3');
  });
});

function Probe() {
  const { t } = useI18n();
  return <p>{t('pool.members')}</p>;
}

describe('locale toggle', () => {
  afterEach(() => window.localStorage.clear());

  it('switches the language and stores it under the key shared with the project page', () => {
    render(
      <I18nProvider>
        <LocaleToggle />
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByText('Members')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'PT-BR' }));
    expect(screen.getByText('Membros')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PT-BR' })).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('pt');
    expect(document.documentElement.lang).toBe('pt-BR');
  });

  it('reads the stored choice (site value "pt") and defaults to English', () => {
    expect(readStoredLocale()).toBe('en');
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'pt');
    expect(readStoredLocale()).toBe('pt-BR');
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'xx');
    expect(readStoredLocale()).toBe('en');
  });
});

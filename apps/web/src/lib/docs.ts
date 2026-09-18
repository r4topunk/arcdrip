// The /docs page (PRD 6), rendered at build time from apps/web/content/<locale>/docs.md. Server-only (node:fs).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { LOCALES, type Locale } from './i18n';
import { type Heading, markdownTitle, renderMarkdown } from './markdown';

const CONTENT_DIR = path.join(process.cwd(), 'content');
const SLUG = 'docs';

export interface RenderedDoc {
  locale: Locale;
  /** False when this locale has no file and the English text is shown instead. */
  translated: boolean;
  title: string;
  html: string;
  headings: Heading[];
  /** Repo-relative path of the file that was rendered, so the page can link to the source. */
  file: string;
}

const fileFor = (locale: Locale) => path.join(CONTENT_DIR, locale, `${SLUG}.md`);

function render(locale: Locale): RenderedDoc {
  const own = fileFor(locale);
  const translated = existsSync(own);
  const source = readFileSync(translated ? own : fileFor('en'), 'utf8');
  return {
    locale,
    translated: locale === 'en' || translated,
    title: markdownTitle(source) ?? 'Docs',
    file: `apps/web/content/${translated ? locale : 'en'}/${SLUG}.md`,
    ...renderMarkdown(source, { basePath: config.basePath, repoUrl: config.repoUrl }),
  };
}

/** Both languages, rendered at build time; the locale toggle picks which one is shown. */
export function loadDocs(): Record<Locale, RenderedDoc> {
  return Object.fromEntries(LOCALES.map((l) => [l, render(l)])) as Record<Locale, RenderedDoc>;
}

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { markdownTitle, renderMarkdown, resolveHref, slugify } from '@/lib/markdown';

const opts = { basePath: '/arcdrip', repoUrl: 'https://github.com/r4topunk/arcdrip' };
const content = (locale: string) =>
  readFileSync(path.join(import.meta.dirname, '..', 'content', locale, 'docs.md'), 'utf8');

describe('markdown rendering', () => {
  it('drops the H1 (the page shows it) and anchors every heading', () => {
    const { html, headings } = renderMarkdown('# Title\n\n## One\n\ntext\n', opts);
    expect(html).not.toContain('<h1');
    expect(html).toContain('id="one"');
    expect(headings).toEqual([{ id: 'one', text: 'One', depth: 2 }]);
  });

  it('never collides two identical headings on the same id', () => {
    const { headings } = renderMarkdown('## FAQ\n\n## FAQ\n', opts);
    expect(headings.map((h) => h.id)).toEqual(['faq', 'faq-1']);
  });

  it('wraps tables so long comparison rows scroll instead of breaking the page', () => {
    const { html } = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n', opts);
    expect(html).toContain('class="table-wrap"');
  });

  it('escapes code blocks rather than injecting them as HTML', () => {
    const { html } = renderMarkdown('```\n<script>x</script>\n```\n', opts);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('rewrites links: site paths get the basePath, repo files point at the repository', () => {
    expect(resolveHref('/pool/', opts)).toEqual({ href: '/arcdrip/pool/', external: false });
    expect(resolveHref('#faq', opts)).toEqual({ href: '#faq', external: false });
    expect(resolveHref('docs/SPEC.md', opts)).toEqual({
      href: 'https://github.com/r4topunk/arcdrip/blob/main/docs/SPEC.md',
      external: true,
    });
    expect(resolveHref('https://arc.io', opts).external).toBe(true);
  });

  it('slugifies accented Portuguese headings into plain ids', () => {
    expect(slugify('Perguntas frequentes')).toBe('perguntas-frequentes');
    expect(slugify('O que é garantido')).toBe('o-que-e-garantido');
  });
});

describe('docs content', () => {
  it('exists in both languages with a title', () => {
    for (const locale of ['en', 'pt-BR']) {
      expect(markdownTitle(content(locale)), locale).toBeTruthy();
    }
  });

  it('has the same section structure in both languages', () => {
    const headings = (locale: string) =>
      renderMarkdown(content(locale), opts).headings.filter((h) => h.depth === 2).length;
    expect(headings('pt-BR')).toBe(headings('en'));
  });

  it('documents the accrual, the guarantees and the comparison the PRD asks for', () => {
    const en = content('en');
    expect(en).toContain('_accrue');
    expect(en).toMatch(/Sablier/);
    expect(en).toMatch(/0xSplits/);
    expect(en).toMatch(/Safe/);
  });
});

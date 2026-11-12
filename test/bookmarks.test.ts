import { describe, expect, it } from 'vitest';
import { bookmarkKey, bumpOpen, cleanOpens, frecency, importFolders, newInFolder, parseBookmarkHtml, rankBookmarks } from '../shared/bookmarks';
import { DEFAULT_ENGINES } from '../shared/defaults';
import type { BookmarkGroup } from '../shared/types';
import { iconLinks, isSignIn, judge, sniffIcon } from '../server/src/bookmarks';
import { searchRows } from '../web/src/components/TopBar';

const DAY = 86_400_000;
const t0 = Date.parse('2026-11-01T00:00:00Z');

describe('ranking by opens', () => {
  it('adds one per open and halves every two weeks', () => {
    const a = bumpOpen(undefined, t0);
    expect(a).toEqual({ score: 1, last: '2026-11-01T00:00:00.000Z', n: 1 });
    const b = bumpOpen(a, t0 + 14 * DAY);
    expect(b.score).toBeCloseTo(1.5);
    expect(b.n).toBe(2);
    expect(frecency(b, t0 + 28 * DAY)).toBeCloseTo(0.75);
    expect(frecency(undefined)).toBe(0);
  });

  it('puts the most opened first, and otherwise keeps the order (names starting with what’s typed ahead)', () => {
    const list = [{ id: 'a', name: 'Gmail', url: 'https://mail.google.com' }, { id: 'b', name: 'GitHub', url: 'https://github.com' }, { id: 'c', name: 'Big', url: 'https://big.example' }];
    expect(rankBookmarks(list, {}, '', t0).map((b) => b.id)).toEqual(['a', 'b', 'c']);
    const opens = { c: bumpOpen(bumpOpen(undefined, t0), t0), b: bumpOpen(undefined, t0 - 60 * DAY) };
    expect(rankBookmarks(list, opens, '', t0).map((b) => b.id)).toEqual(['c', 'b', 'a']);
    // A long time ago counts for little, but more than never.
    expect(rankBookmarks(list, { b: bumpOpen(undefined, t0 - 200 * DAY) }, '', t0).map((b) => b.id)).toEqual(['b', 'a', 'c']);
    expect(rankBookmarks(list, {}, 'gi', t0).map((b) => b.id)).toEqual(['b', 'a', 'c']);
  });

  it('ranks the search box’s bookmark results the same way', () => {
    const bms = [{ id: '1', name: 'Grafana', url: 'https://grafana.example' }, { id: '2', name: 'Google Drive', url: 'https://drive.google.com' }];
    expect(searchRows('g', bms, DEFAULT_ENGINES).slice(0, 2).map((r) => r.key)).toEqual(['b:1', 'b:2']);
    expect(searchRows('g', bms, DEFAULT_ENGINES, { '2': bumpOpen(undefined) }).slice(0, 2).map((r) => r.key)).toEqual(['b:2', 'b:1']);
  });

  it('keeps counts only for bookmarks that are still there', () => {
    const o = { a: bumpOpen(undefined, t0), gone: bumpOpen(undefined, t0), bad: { score: 'x', last: 'no' } };
    expect(Object.keys(cleanOpens(o, new Set(['a', 'bad'])))).toEqual(['a']);
    expect(cleanOpens(null)).toEqual({});
  });
});

const CHROME = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://mail.google.com/" ADD_DATE="1" ICON="data:image/png;base64,AAAA">Gmail</A>
        <DT><H3 ADD_DATE="1">Dev &amp; tools</H3>
        <DL><p>
            <DT><A HREF="https://github.com/">GitHub</A>
            <DT><A HREF="https://www.github.com">GitHub again</A>
            <DT><A HREF="javascript:void(0)">A bookmarklet</A>
        </DL><p>
        <DT><A HREF="https://news.example/">News</A>
    </DL><p>
    <DT><H3>Empty</H3>
    <DL><p>
    </DL><p>
    <DT><A HREF="https://loose.example/">Loose</A>
</DL><p>`;

const FIREFOX = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<title>Bookmarks</title>
<h1>Bookmarks Menu</h1>
<dl><p>
  <dt><h3 add_date="1">Mozilla Firefox</h3>
  <dl><p>
    <dt><a href="https://support.mozilla.org/products/firefox" add_date="1">Get Help</a>
    <dd>A description that isn't a link
  </dl><p>
  <dt><a href="https://example.org/a?b=1&amp;c=2"></a>
</dl>`;

describe('importing a browser’s bookmarks', () => {
  it('reads Chrome’s export: folders, their own links, and links outside any folder', () => {
    const f = parseBookmarkHtml(CHROME);
    expect(f.map((x) => x.path.join(' › '))).toEqual(['', 'Bookmarks bar', 'Bookmarks bar › Dev & tools', 'Empty']);
    expect(f[0].items).toEqual([{ name: 'Loose', url: 'https://loose.example/' }]);
    expect(f[1].items.map((b) => b.name)).toEqual(['Gmail', 'News']);
    expect(f[2].items.map((b) => b.name)).toEqual(['GitHub', 'GitHub again']);
    expect(f[3].items).toEqual([]);
  });

  it('reads Firefox’s lower-case export, naming a link without a title after its site', () => {
    const f = parseBookmarkHtml(FIREFOX);
    expect(f[0].items).toEqual([{ name: 'example.org', url: 'https://example.org/a?b=1&c=2' }]);
    expect(f[1]).toEqual({ path: ['Mozilla Firefox'], items: [{ name: 'Get Help', url: 'https://support.mozilla.org/products/firefox' }] });
  });

  it('makes groups of the chosen folders, adds to a group of the same name, and skips what’s there', () => {
    let n = 0;
    const id = (p: string) => `${p}${++n}`;
    const groups: BookmarkGroup[] = [{ id: 'g1', name: 'Bookmarks bar', items: [{ id: 'b1', name: 'Mail', url: 'http://mail.google.com' }] }];
    const f = parseBookmarkHtml(CHROME);
    expect(newInFolder(groups, f[1])).toBe(1);
    expect(newInFolder(groups, f[2])).toBe(1);
    const r = importFolders(groups, f, [1, 2], id);
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(2);
    expect(r.groups.map((g) => [g.name, g.items.map((b) => b.name)])).toEqual([
      ['Bookmarks bar', ['Mail', 'News']],
      ['Dev & tools', ['GitHub']],
    ]);
    // What's there is left as it was.
    expect(groups[0].items).toHaveLength(1);
    expect(importFolders(groups, f, [0], id).groups[1].name).toBe('Imported');
  });

  it('counts the same page as the same bookmark', () => {
    expect(bookmarkKey('http://www.Example.com/a/')).toBe(bookmarkKey('https://example.com/a#x'));
    expect(bookmarkKey('https://example.com/a?x=1')).not.toBe(bookmarkKey('https://example.com/a?x=2'));
  });
});

describe('the link check', () => {
  it('flags not found and server errors; logins and bot blocks are fine', () => {
    expect(judge(200)).toBeNull();
    expect(judge(401)).toBeNull();
    expect(judge(403)).toBeNull();
    expect(judge(429)).toBeNull();
    expect(judge(404)).toEqual({ kind: 'gone', why: 'Not found (404)' });
    expect(judge(410)?.kind).toBe('gone');
    expect(judge(503)).toEqual({ kind: 'failing', why: 'Server error (503)' });
  });

  it('treats a redirect to a sign-in page, Cloudflare Access’s included, as fine', () => {
    expect(isSignIn(new URL('https://myteam.cloudflareaccess.com/cdn-cgi/access/login/app.example.com?kid=1'))).toBe(true);
    expect(isSignIn(new URL('https://app.example.com/cdn-cgi/access/login'))).toBe(true);
    expect(isSignIn(new URL('https://accounts.google.com/ServiceLogin?continue=x'))).toBe(true);
    expect(isSignIn(new URL('https://grafana.example/login'))).toBe(true);
    expect(isSignIn(new URL('https://example.com/blog/how-to-login-faster-guide'))).toBe(false);
    expect(isSignIn(new URL('https://github.com/anthropics'))).toBe(false);
  });
});

describe('favicons', () => {
  it('picks the smallest sharp icon on the page, then bigger, then the rest', () => {
    const html = `<head>
      <link rel="icon" href="/favicon-16.png" sizes="16x16">
      <link rel="icon" type="image/png" href="/favicon-32.png" sizes="32x32">
      <link rel="mask-icon" href="/mask.svg">
      <link rel="apple-touch-icon" href="https://cdn.example/touch.png">
      <link rel="shortcut icon" href="data:image/png;base64,AAAA">
    </head>`;
    expect(iconLinks(html, 'https://site.example/home')).toEqual(['https://site.example/favicon-32.png', 'https://cdn.example/touch.png', 'https://site.example/favicon-16.png']);
  });

  it('keeps only image files', () => {
    expect(sniffIcon(new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16]))).toBe('image/x-icon');
    expect(sniffIcon(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe('image/png');
    expect(sniffIcon(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml');
    expect(sniffIcon(Buffer.from('<!doctype html><html>'))).toBeNull();
  });
});

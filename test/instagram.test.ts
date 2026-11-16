import { describe, expect, it } from 'vitest';
import { cleanIgLimit, IG_DEFAULT_LIMIT, IG_MAX_LIMIT, IG_MAX_POSTS, igFileName, igLabel, parseInstagram } from '../shared/instagram';
import { parseIgCookies } from '../server/src/instagram';
import { igDetail, igPercent, linkKind } from '../web/src/components/Downloads';
import type { DownloadJob, IgProgress } from '../shared/types';

describe('Instagram links', () => {
  it('finds posts and reels, however they were copied', () => {
    expect(parseInstagram('https://www.instagram.com/p/Dfy4Kk4lLtY/')).toEqual({ posts: ['Dfy4Kk4lLtY'], profile: null });
    expect(parseInstagram('https://www.instagram.com/reel/Dfy0nLPsmAq/?igsh=MWQ1ZGUxMzBkMA==')).toEqual({ posts: ['Dfy0nLPsmAq'], profile: null });
    expect(parseInstagram('instagram.com/reels/Dfy0nLPsmAq')).toEqual({ posts: ['Dfy0nLPsmAq'], profile: null });
    expect(parseInstagram('https://m.instagram.com/tv/ABCdef123_-/')).toEqual({ posts: ['ABCdef123_-'], profile: null });
    expect(parseInstagram('https://www.instagram.com/aespa_official/p/Dfy4Kk4lLtY/')).toEqual({ posts: ['Dfy4Kk4lLtY'], profile: null });
    expect(parseInstagram('http://instagr.am/p/Dfy4Kk4lLtY')).toEqual({ posts: ['Dfy4Kk4lLtY'], profile: null });
  });

  it('takes several posts, one a line, without repeats', () => {
    const text = 'https://www.instagram.com/p/AAAAA11111/\n\n  https://www.instagram.com/reel/BBBBB22222/ \nhttps://www.instagram.com/p/AAAAA11111/?img_index=2';
    expect(parseInstagram(text)).toEqual({ posts: ['AAAAA11111', 'BBBBB22222'], profile: null });
    const many = Array.from({ length: IG_MAX_POSTS + 1 }, (_, i) => `https://www.instagram.com/p/CODE${String(i).padStart(4, '0')}/`).join('\n');
    expect(parseInstagram(many)).toHaveProperty('error');
  });

  it('finds a profile by link or @name', () => {
    expect(parseInstagram('https://www.instagram.com/NatGeo/')).toEqual({ posts: [], profile: 'natgeo' });
    expect(parseInstagram('https://www.instagram.com/natgeo?igsh=abc')).toEqual({ posts: [], profile: 'natgeo' });
    expect(parseInstagram('https://www.instagram.com/natgeo/reels/')).toEqual({ posts: [], profile: 'natgeo' });
    expect(parseInstagram('@aespa_official')).toEqual({ posts: [], profile: 'aespa_official' });
  });

  it('says why an Instagram link won’t do', () => {
    for (const bad of [
      'https://www.instagram.com/stories/natgeo/3456789/',
      'https://www.instagram.com/share/AbCdEf/',
      'https://www.instagram.com/explore/',
      'https://www.instagram.com/accounts/login/',
      'https://www.instagram.com/p/',
      'https://www.instagram.com/p/!!/',
      'https://www.instagram.com/natgeo/\nhttps://www.instagram.com/p/AAAAA11111/',
      '@one\n@two',
      'https://www.instagram.com/p/AAAAA11111/\nhttps://example.com/a.zip',
    ]) {
      expect(parseInstagram(bad), bad).toHaveProperty('error');
    }
  });

  it('leaves everything else to the other downloads', () => {
    for (const other of ['https://example.com/a.zip', 'magnet:?xt=urn:btih:abc', 'https://notinstagram.com/p/AAAAA11111/', '', '   ', 'just words']) {
      expect(parseInstagram(other), other).toBe(null);
    }
  });

  it('sends Instagram links to Instagram, and unusable ones nowhere', () => {
    expect(linkKind('https://www.instagram.com/p/Dfy4Kk4lLtY/')).toBe('instagram');
    expect(linkKind('@natgeo')).toBe('instagram');
    expect(linkKind('https://www.instagram.com/stories/natgeo/1/')).toBe(null);
    expect(linkKind('https://example.com/ubuntu.iso')).toBe('http');
    expect(linkKind('magnet:?xt=urn:btih:abc')).toBe('torrent');
  });

  it('keeps a profile’s limit in range', () => {
    expect(cleanIgLimit(5)).toBe(5);
    expect(cleanIgLimit('20')).toBe(20);
    expect(cleanIgLimit(0)).toBe(1);
    expect(cleanIgLimit(9999)).toBe(IG_MAX_LIMIT);
    expect(cleanIgLimit(2.6)).toBe(3);
    expect(cleanIgLimit('lots')).toBe(IG_DEFAULT_LIMIT);
    expect(cleanIgLimit(undefined)).toBe(IG_DEFAULT_LIMIT);
  });

  it('names files the way instaloader does', () => {
    expect(igFileName('2026-11-16_07-00-32_UTC', 0, 1, 'jpg')).toBe('2026-11-16_07-00-32_UTC.jpg');
    expect(igFileName('2026-11-16_07-00-32_UTC', 0, 5, 'jpg')).toBe('2026-11-16_07-00-32_UTC_1.jpg');
    expect(igFileName('2026-11-16_07-00-32_UTC', 4, 5, 'MP4')).toBe('2026-11-16_07-00-32_UTC_5.mp4');
    expect(igFileName('2026-11-16_07-00-32_UTC', 0, 1, '../x')).toBe('2026-11-16_07-00-32_UTC.jpg');
  });

  it('labels a job before Instagram answers', () => {
    expect(igLabel({ posts: ['AAAAA11111'], profile: null }, 0)).toBe('Instagram post AAAAA11111');
    expect(igLabel({ posts: ['AAAAA11111', 'BBBBB22222'], profile: null }, 0)).toBe('2 Instagram posts');
    expect(igLabel({ posts: [], profile: 'natgeo' }, 12)).toBe('@natgeo · newest 12');
  });
});

describe('Instagram session cookies', () => {
  it('takes the sessionid on its own', () => {
    expect(parseIgCookies('  1234567%3AAbCdEf%3A12%3AAYc  ')).toEqual({ sessionid: '1234567%3AAbCdEf%3A12%3AAYc' });
  });

  it('takes a Cookie header, keeping only Instagram’s session cookies', () => {
    expect(parseIgCookies('cookie: csrftoken=abc123; sessionid=111%3Axyz; ds_user_id=111; _ga=GA1.2.3; ig_did="ABC-DEF"')).toEqual({
      csrftoken: 'abc123',
      sessionid: '111%3Axyz',
      ds_user_id: '111',
      ig_did: 'ABC-DEF',
    });
  });

  it('takes a JSON cookie export', () => {
    const json = JSON.stringify([
      { name: 'sessionid', value: '111%3Axyz', domain: '.instagram.com' },
      { name: 'csrftoken', value: 'abc' },
      { name: 'other', value: 'x' },
    ]);
    expect(parseIgCookies(json)).toEqual({ sessionid: '111%3Axyz', csrftoken: 'abc' });
  });

  it('refuses anything without a usable sessionid', () => {
    for (const bad of ['', '   ', 'csrftoken=abc', '[{"name":"csrftoken","value":"x"}]', '[not json', 'sessionid=has space', 'sessionid=', 42, null]) {
      expect(parseIgCookies(bad), String(bad)).toBe(null);
    }
  });
});

describe('Instagram job progress', () => {
  const base: IgProgress = { limit: null, metadata: false, want: 1, postsDone: 0, current: null, files: 0, skipped: 0, failed: 0, lastError: null, folder: null, queued: false, waitUntil: null };
  const job = (state: DownloadJob['state'], ig: Partial<IgProgress>, extra: Partial<DownloadJob> = {}): DownloadJob => ({
    id: 'x',
    url: 'https://www.instagram.com/p/AAAAA11111/',
    name: '@a · AAAAA11111',
    dir: '/home/me/Downloads',
    received: 3_000_000,
    total: null,
    bps: 0,
    state,
    error: null,
    startedAt: '2026-11-16T00:00:00Z',
    endedAt: null,
    ig: { ...base, ...ig },
    ...extra,
  });

  it('says where a running job has got to', () => {
    expect(igDetail(job('starting', { queued: true }))).toMatch(/Instagram download before it/);
    expect(igDetail(job('starting', {}))).toBe('Finding the post…');
    expect(igDetail(job('starting', { limit: 12, want: 12 }))).toBe('Finding the posts…');
    expect(igDetail(job('downloading', { waitUntil: '2026-11-16T06:05:00Z' }))).toBe('Instagram asked to slow down · carrying on at 14:05');
    expect(igDetail(job('downloading', { current: { done: 2, of: 5 } }))).toBe('file 3 of 5 · 3.00 MB');
    expect(igDetail(job('downloading', { want: 12, limit: 12, postsDone: 3, current: { done: 0, of: 1 } }))).toBe('post 4 of 12 · 3.00 MB');
    // Nothing new yet, just files already there: no "0 B", and no speed that's still settling.
    expect(igDetail(job('downloading', { want: 60, limit: 60, postsDone: 2, skipped: 4, current: { done: 0, of: 1 } }, { received: 0, bps: 0.4 }))).toBe('post 3 of 60 · 4 already there');
    expect(igDetail(job('downloading', { current: { done: 1, of: 2 } }, { bps: 1_500_000 }))).toBe('file 2 of 2 · 3.00 MB · 1.50 MB/s');
  });

  it('says what a finished job saved', () => {
    expect(igDetail(job('done', { postsDone: 1, files: 5, folder: '/home/me/Downloads/a' }))).toBe('5 files · 3.00 MB · in /home/me/Downloads/a');
    expect(igDetail(job('done', { postsDone: 1, files: 1, skipped: 4, folder: '/d/a' }))).toBe('1 file · 3.00 MB · 4 already there · in /d/a');
    expect(igDetail(job('done', { postsDone: 1, skipped: 5, folder: '/d/a' }, { received: 0 }))).toBe('5 already there · in /d/a');
    expect(igDetail(job('done', { postsDone: 3, files: 2, failed: 1, folder: '/d/a' }))).toBe('2 files · 3.00 MB · 1 post couldn’t be read · in /d/a');
    expect(igDetail(job('done', { limit: 12, want: 12 }))).toBe('No posts to save');
    expect(igDetail(job('cancelled', { files: 2 }))).toBe('Cancelled · 2 files · 3.00 MB saved');
    expect(igDetail(job('cancelled', {}))).toBe('Cancelled');
    expect(igDetail(job('failed', {}, { error: 'There’s no Instagram account by that name.' }))).toBe('There’s no Instagram account by that name.');
  });

  it('fills the bar by posts, and by files within the one being saved', () => {
    expect(igPercent({ ...base })).toBe(null);
    expect(igPercent({ ...base, queued: true, postsDone: 1, want: 2 })).toBe(null);
    expect(igPercent({ ...base, current: { done: 1, of: 4 } })).toBe(25);
    expect(igPercent({ ...base, want: 4, postsDone: 2, current: { done: 1, of: 2 } })).toBe(62.5);
    expect(igPercent({ ...base, want: 2, postsDone: 3 })).toBe(100);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanVideoFormat, videoLink, wantsVideo } from '../shared/video';
import { HelperError, runHelper, type Helper } from '../server/src/helper';
import { MIN_FREE, roomFor, stepOf, videoBytes } from '../server/src/ytdlp';
import { downloadFinished, onDownloadFinished, type FinishedDownload } from '../server/src/downloads';
import { linkKind, siteIcon, videoDetail, videoPercent } from '../web/src/components/Downloads';
import type { DownloadJob, VideoProgress } from '../shared/types';

describe('video links', () => {
  it('knows YouTube links, and what they say about playlists', () => {
    expect(videoLink('https://www.youtube.com/watch?v=jNQXAC9IVRw')).toMatchObject({ site: 'YouTube', playlist: null, audio: false });
    expect(videoLink('https://youtu.be/jNQXAC9IVRw?si=abc')).toMatchObject({ site: 'YouTube', playlist: null });
    expect(videoLink('https://m.youtube.com/shorts/abcdEFGhij0')).toMatchObject({ site: 'YouTube', playlist: null });
    expect(videoLink('https://music.youtube.com/watch?v=abc')).toMatchObject({ site: 'YouTube' });
    expect(videoLink('https://www.youtube.com/watch?v=abc&list=PL123')).toMatchObject({ playlist: 'also' });
    expect(videoLink('https://youtu.be/abc?list=PL123')).toMatchObject({ playlist: 'also' });
    expect(videoLink('https://www.youtube.com/playlist?list=PL123')).toMatchObject({ playlist: 'only' });
    expect(videoLink('https://www.youtube.com/@natgeo')).toMatchObject({ playlist: 'only' });
    expect(videoLink('youtube.com/watch?v=abc')).toMatchObject({ site: 'YouTube', href: 'https://youtube.com/watch?v=abc' });
  });

  it('knows X, TikTok, Reddit and SoundCloud', () => {
    expect(videoLink('https://x.com/someone/status/1234567890')?.site).toBe('X');
    expect(videoLink('https://twitter.com/someone/status/1234567890')?.site).toBe('X');
    expect(videoLink('https://mobile.twitter.com/someone/status/1')?.site).toBe('X');
    expect(videoLink('https://www.tiktok.com/@someone/video/7234567890123456789')?.site).toBe('TikTok');
    expect(videoLink('https://vm.tiktok.com/ZMabc123/')?.site).toBe('TikTok');
    expect(videoLink('https://www.reddit.com/r/videos/comments/abc123/a_title/')?.site).toBe('Reddit');
    expect(videoLink('https://old.reddit.com/r/videos/comments/abc123/')?.site).toBe('Reddit');
    expect(videoLink('https://v.redd.it/abc123')?.site).toBe('Reddit');
    expect(videoLink('https://soundcloud.com/artist/a-track')).toMatchObject({ site: 'SoundCloud', audio: true, playlist: null });
    expect(videoLink('https://soundcloud.com/artist/sets/an-album')).toMatchObject({ playlist: 'only' });
    expect(videoLink('https://soundcloud.com/artist/a-track?in=artist/sets/an-album')).toMatchObject({ playlist: 'also' });
    expect(videoLink('https://soundcloud.com/artist')).toMatchObject({ playlist: 'only' });
    expect(videoLink('https://on.soundcloud.com/AbCd1')).toMatchObject({ site: 'SoundCloud', playlist: null });
  });

  it('leaves everything else alone', () => {
    for (const other of [
      'https://vimeo.com/76979871',
      'https://example.com/a.zip',
      'https://i.redd.it/picture.jpg',
      'https://notyoutube.com/watch?v=abc',
      'https://www.instagram.com/p/Dfy4Kk4lLtY/',
      'magnet:?xt=urn:btih:abc',
      'ftp://youtube.com/watch?v=abc',
      'https://youtube.com/watch?v=a\nhttps://youtube.com/watch?v=b',
      'just words',
      '',
    ]) {
      expect(videoLink(other), other).toBe(null);
    }
  });

  it('sends video links to yt-dlp, and the rest where they went before', () => {
    expect(linkKind('https://www.youtube.com/watch?v=jNQXAC9IVRw')).toBe('video');
    expect(linkKind('  https://x.com/a/status/1  ')).toBe('video');
    expect(linkKind('https://vimeo.com/76979871')).toBe('http');
    expect(linkKind('https://www.instagram.com/reel/Dfy0nLPsmAq/')).toBe('instagram');
    expect(linkKind('https://www.youtube.com/watch?v=a\nhttps://www.youtube.com/watch?v=b')).toBe(null);
    expect(linkKind('magnet:?xt=urn:btih:abc')).toBe('torrent');
  });

  it('sends YouTube links to yt-dlp on the server even when the page doesn’t say to', () => {
    expect(wantsVideo({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' })).toBe(true);
    expect(wantsVideo({ url: 'https://youtu.be/jNQXAC9IVRw?si=abc' })).toBe(true);
    expect(wantsVideo({ url: 'youtu.be/jNQXAC9IVRw' })).toBe(true);
    expect(wantsVideo({ url: 'https://youtube.com/shorts/abcdEFGhij0?si=x' })).toBe(true);
    expect(wantsVideo({ url: 'https://vimeo.com/76979871', via: 'video' })).toBe(true);
    expect(wantsVideo({ url: 'https://vimeo.com/76979871' })).toBe(false);
    expect(wantsVideo({ url: 'https://example.com/watch' })).toBe(false);
    expect(wantsVideo({ url: 42 })).toBe(false);
    expect(wantsVideo(null)).toBe(false);
  });

  it('takes a known format, or the best', () => {
    expect(cleanVideoFormat('mp3')).toBe('mp3');
    expect(cleanVideoFormat('1080p')).toBe('1080p');
    expect(cleanVideoFormat('4k')).toBe('best');
    expect(cleanVideoFormat(undefined)).toBe('best');
  });
});

describe('room for a video', () => {
  const GB = 1e9;
  it('goes ahead when the system won’t say, or the size isn’t known', () => {
    expect(roomFor(null, [5 * GB], 0)).toBe(null);
    expect(roomFor(10 * GB, [null], 0)).toBe(null);
    expect(roomFor(10 * GB, [], 0)).toBe(null);
  });

  it('wants twice the video and a margin, after what the others need', () => {
    expect(roomFor(10 * GB, [2 * GB, 0.5 * GB], 0)).toBe(null);
    expect(roomFor(10 * GB, [4 * GB, 1 * GB], 0)).toMatch(/needs about 10\.\d GB free .* there’s 10\.0 GB/);
    expect(roomFor(10 * GB, [2 * GB], 5 * GB)).toBe(null);
    expect(roomFor(10 * GB, [2 * GB], 6 * GB)).toMatch(/needs about/);
  });

  it('refuses to start at all when the data folder is nearly full', () => {
    expect(roomFor(MIN_FREE - 1, [], 0)).toMatch(/has only \d+ MB free/);
    expect(roomFor(2 * GB, [], 1.9 * GB)).toMatch(/too little/);
  });
});

describe('a video’s progress', () => {
  it('adds up its parts, the video and then its sound', () => {
    expect(videoBytes([100, 50], [40])).toEqual({ received: 40, total: 150 });
    expect(videoBytes([100, 50], [100, 25])).toEqual({ received: 125, total: 150 });
    expect(videoBytes([100, null], [100, 25])).toEqual({ received: 125, total: null });
    expect(videoBytes([100], [130])).toEqual({ received: 130, total: 130 });
    expect(videoBytes([], [10])).toEqual({ received: 10, total: null });
  });

  it('names what ffmpeg is doing', () => {
    expect(stepOf('Merger')).toBe('join');
    expect(stepOf('ExtractAudio')).toBe('mp3');
    expect(stepOf('VideoRemuxer')).toBe('mp4');
    expect(stepOf('Metadata')).toBe('tags');
    expect(stepOf('FixupM3u8')).toBe('fix');
  });

  const job = (state: DownloadJob['state'], v: Partial<VideoProgress>, more: Partial<DownloadJob> = {}): DownloadJob => ({
    id: 'x',
    url: 'https://www.youtube.com/watch?v=abc',
    name: 'Me at the zoo',
    dir: '/home/me/Downloads',
    received: 0,
    total: null,
    bps: 0,
    state,
    error: null,
    startedAt: '2026-11-18T00:00:00.000Z',
    endedAt: null,
    video: { format: 'best', site: 'Youtube', title: null, phase: 'finding', part: 0, parts: 1, step: null, playlist: false, ...v },
    ...more,
  });

  it('says where it has got to', () => {
    expect(videoDetail(job('starting', {}))).toBe('Finding the video…');
    expect(videoDetail(job('starting', { site: 'Soundcloud' }))).toBe('Finding the track…');
    expect(videoDetail(job('downloading', { phase: 'downloading' }, { received: 2e6, total: 8e6, bps: 1e6 }))).toBe('2.00 MB of 8.00 MB · 1.00 MB/s · 6 s left');
    expect(videoDetail(job('downloading', { phase: 'downloading' }))).toBe('Downloading…');
    expect(videoDetail(job('downloading', { phase: 'processing', step: 'join' }))).toBe('Joining the picture and sound…');
    expect(videoDetail(job('downloading', { phase: 'processing', step: 'mp3' }))).toBe('Making the MP3…');
    expect(videoDetail(job('downloading', { phase: 'saving' }, { received: 1e6, total: 4e6 }))).toBe('Saving into /home/me/Downloads · 1.00 MB of 4.00 MB');
    expect(videoDetail(job('done', { phase: 'saving' }, { received: 4e6, total: 4e6 }))).toBe('4.00 MB · in /home/me/Downloads');
    expect(videoDetail(job('done', { phase: 'saving', playlist: true }, { received: 4e6 }))).toBe('4.00 MB · in /home/me/Downloads · the first of the playlist');
    expect(videoDetail(job('failed', {}, { error: 'Video unavailable.' }))).toBe('Video unavailable.');
    expect(videoDetail(job('cancelled', {}))).toBe('Cancelled');
  });

  it('has a bar only while bytes are moving and their total is known', () => {
    expect(videoPercent(job('starting', {}))).toBe(null);
    expect(videoPercent(job('downloading', { phase: 'downloading' }, { received: 25, total: 100 }))).toBe(25);
    expect(videoPercent(job('downloading', { phase: 'downloading' }, { received: 25 }))).toBe(null);
    expect(videoPercent(job('downloading', { phase: 'processing' }, { received: 100, total: 100 }))).toBe(null);
    expect(videoPercent(job('downloading', { phase: 'saving' }, { received: 50, total: 100 }))).toBe(50);
  });

  it('shows its site’s logo, or a note for an MP3', () => {
    expect(siteIcon('Youtube', 'best')).toBe('ph-youtube-logo');
    expect(siteIcon('YouTube', '1080p')).toBe('ph-youtube-logo');
    expect(siteIcon('Twitter', 'best')).toBe('ph-x-logo');
    expect(siteIcon('TikTok', 'best')).toBe('ph-tiktok-logo');
    expect(siteIcon('Youtube', 'mp3')).toBe('ph-music-note');
    expect(siteIcon('Vimeo', 'best')).toBe('ph-film-strip');
    expect(siteIcon(null, 'best')).toBe('ph-film-strip');
  });
});

describe('the Python helpers’ runner', () => {
  // A stand-in for a helper: Node runs a script that answers like one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-helper-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const helper = (body: string): Helper => {
    const script = path.join(dir, `h${Math.random().toString(36).slice(2)}.cjs`);
    fs.writeFileSync(script, `let input = ''; process.stdin.on('data', (d) => (input += d)); process.stdin.on('end', () => { const req = JSON.parse(input); const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n'); ${body} });`);
    return { python: process.execPath, script, missing: 'Not installed.', slow: 'Too slow.', name: 'test' };
  };

  it('hands over each line and ends with the helper', async () => {
    const seen: unknown[] = [];
    await runHelper(helper(`say({ type: 'echo', got: req.n }); process.stdout.write('not json\\n'); say({ type: 'done' });`), { n: 7 }, (e) => void seen.push(e));
    expect(seen).toEqual([{ type: 'echo', got: 7 }, { type: 'done' }]);
  });

  it('rejects with what the helper said went wrong', async () => {
    const run = runHelper(helper(`say({ type: 'error', error: 'Video unavailable.', code: 'other' });`), {}, () => {});
    await expect(run).rejects.toThrow('Video unavailable.');
    await expect(runHelper(helper(`say({ type: 'error', error: 'x', code: 'missing' });`), {}, () => {})).rejects.toMatchObject({ message: 'Not installed.', code: 'missing' });
  });

  it('gives the last thing it printed when it stops without saying why', async () => {
    await expect(runHelper(helper(`console.error('first'); console.error('Traceback: it broke'); process.exit(3);`), {}, () => {})).rejects.toThrow('Traceback: it broke');
  });

  it('says so when there’s no Python to run', async () => {
    const err = await runHelper({ ...helper(''), python: path.join(dir, 'no-such-python') }, {}, () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(HelperError);
    expect(err.code).toBe('missing');
  });

  it('stops it when cancelled or when it takes too long', async () => {
    const slow = helper(`say({ type: 'started' }); setTimeout(() => say({ type: 'done' }), 20000);`);
    const ctl = new AbortController();
    const run = runHelper(slow, {}, (e: { type: string }) => e.type === 'started' && ctl.abort(new Error('Cancelled')), { signal: ctl.signal, group: true });
    await expect(run).rejects.toThrow('Cancelled');
    await expect(runHelper(slow, {}, () => {}, { timeout: 300 })).rejects.toThrow('Too slow.');
  });
});

describe('the download-finished hook', () => {
  it('tells every listener, and one that fails doesn’t stop the rest', async () => {
    const got: FinishedDownload[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const offBad = onDownloadFinished(() => {
      throw new Error('boom');
    });
    const off = onDownloadFinished((d) => void got.push(d));
    downloadFinished({ source: 'video', id: '1', name: 'a.mp4', path: '/home/me/Downloads/a.mp4', isDir: false });
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(got[0]).toEqual({ source: 'video', id: '1', name: 'a.mp4', path: '/home/me/Downloads/a.mp4', isDir: false });
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    off();
    offBad();
    downloadFinished({ source: 'link', id: '2', name: 'b.zip', path: '/b.zip', isDir: false });
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toHaveLength(1);
    errors.mockRestore();
  });
});

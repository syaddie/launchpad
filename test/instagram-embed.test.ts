// server/src/instagram.py's fallback: when Instagram won't answer instaloader about a post, the
// helper reads the post's embed page. Runs the real helper with stand-ins for instaloader (which
// fails the way it's told to) and requests (which serves test/fixtures/instagram), so nothing
// goes to Instagram. Skipped where there's no Python.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'server/src/instagram.py');
const FIXTURES = path.join(ROOT, 'test/fixtures/instagram');

const PYTHON = ['python3', 'python'].find((p) => {
  const r = spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.trim() === '3';
});

const STUB_INSTALOADER = `
import os
from . import exceptions

__version__ = "0.test"


class RateController:
    def __init__(self, ctx):
        pass


class _Context:
    username = None


class Instaloader:
    def __init__(self, **kw):
        self.context = _Context()


class Post:
    @staticmethod
    def from_shortcode(ctx, code):
        how = os.environ["IG_STUB_FAIL"]
        if how == "empty":
            raise exceptions.BadResponseException("Fetching Post metadata failed.")
        if how == "wait":
            raise exceptions.ConnectionException('JSON Query to graphql/query: 401 Unauthorized - "fail" status, message "Please wait a few minutes before you try again."')
        if how == "login":
            raise exceptions.LoginRequiredException("Login required.")
        raise AssertionError(how)
`;

const STUB_EXCEPTIONS = `
class InstaloaderException(Exception): pass
class ConnectionException(InstaloaderException): pass
class BadResponseException(ConnectionException): pass
class QueryReturnedNotFoundException(ConnectionException): pass
class TooManyRequestsException(ConnectionException): pass
class LoginRequiredException(InstaloaderException): pass
class LoginException(InstaloaderException): pass
class PrivateProfileNotFollowedException(InstaloaderException): pass
class ProfileNotExistsException(InstaloaderException): pass
class InvalidArgumentException(InstaloaderException): pass
`;

const STUB_REQUESTS = `
import os


class RequestException(Exception):
    pass


class _Response:
    def __init__(self, status, text):
        self.status_code, self.text = status, text


def get(url, timeout=None, allow_redirects=True, headers=None):
    if headers and "Mozilla" in headers.get("User-Agent", ""):
        raise AssertionError("asked for the page as a browser")
    if os.environ.get("IG_STUB_EMBED") == "down":
        raise RequestException("unreachable")
    code = url.split("/p/")[1].split("/")[0]
    page = os.path.join(os.environ["IG_STUB_PAGES"], code + ".html")
    if not os.path.exists(page):
        return _Response(404, "")
    with open(page, encoding="utf-8") as f:
        return _Response(200, f.read())
`;

// Each test starts Python a few times, which is slow while the rest of the suite runs too.
describe.skipIf(!PYTHON)('Instagram posts from the embed page', { timeout: 60_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-igembed-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stubs = path.join(dir, 'stubs');
  const pages = path.join(dir, 'pages');
  fs.mkdirSync(path.join(stubs, 'instaloader'), { recursive: true });
  fs.mkdirSync(pages);
  fs.writeFileSync(path.join(stubs, 'instaloader', '__init__.py'), STUB_INSTALOADER);
  fs.writeFileSync(path.join(stubs, 'instaloader', 'exceptions.py'), STUB_EXCEPTIONS);
  fs.writeFileSync(path.join(stubs, 'requests.py'), STUB_REQUESTS);
  // Each post's embed page, by shortcode, as the stand-in serves them; Gone0000000 has none (404).
  fs.copyFileSync(path.join(FIXTURES, 'embed-sidecar.html'), path.join(pages, 'Df7E7GvG_2T.html'));
  fs.copyFileSync(path.join(FIXTURES, 'embed-video.html'), path.join(pages, 'Dfy0nLPsmAq.html'));
  fs.copyFileSync(path.join(FIXTURES, 'embed-missing.html'), path.join(pages, 'ZZZZZZZZZZZ.html'));
  fs.writeFileSync(path.join(pages, 'Broken00000.html'), '<html><body>Something else entirely</body></html>');

  const run = (posts: string[], fail: 'empty' | 'wait' | 'login', embed: 'up' | 'down' = 'up') => {
    const r = spawnSync(PYTHON!, [SCRIPT], {
      input: JSON.stringify({ cmd: 'resolve', posts }),
      encoding: 'utf8',
      cwd: dir,
      windowsHide: true,
      env: { ...process.env, PYTHONPATH: stubs, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', IG_STUB_FAIL: fail, IG_STUB_PAGES: pages, IG_STUB_EMBED: embed },
    });
    expect(r.stderr).toBe('');
    return { status: r.status, events: r.stdout.trim().split('\n').map((l) => JSON.parse(l)) };
  };

  it('reads every slide of a post, at its largest size, when instaloader gets nothing back', () => {
    const { status, events } = run(['Df7E7GvG_2T'], 'empty');
    expect(status).toBe(0);
    expect(events.map((e) => e.type)).toEqual(['post', 'done']);
    const post = events[0];
    expect(post).toMatchObject({ shortcode: 'Df7E7GvG_2T', owner: 'na.rin', caption: 'run forrest run!!', stem: '2026-11-19_12-26-08_UTC' });
    expect(post.items).toHaveLength(3);
    for (const item of post.items) {
      expect(item.ext).toBe('jpg');
      // The full-size photo, not the 640px one listed first.
      expect(item.url).toMatch(/^https:\/\/scontent\.cdninstagram\.com\/v\/t51\/\d+_n\.jpg\?stp=dst-jpg_e35&/);
    }
    expect(new Set(post.items.map((i: { url: string }) => i.url)).size).toBe(3);
    expect(post.info).toMatchObject({ type: 'GraphSidecar', media: 3, likes: 83675, comments: 397, owner: 'na.rin', taken_at_utc: '2026-11-19T12:26:08Z', via: 'embed' });
  });

  it('reads a reel’s video, and carries on after Instagram’s “please wait”', () => {
    const { events } = run(['Dfy0nLPsmAq'], 'wait');
    expect(events[0]).toMatchObject({ type: 'post', owner: 'aespa_official', stem: '2026-11-16_07-29-40_UTC', info: { type: 'GraphVideo', media: 1 } });
    expect(events[0].caption).toContain('avatar calling\u{1f4de}');
    expect(events[0].items).toEqual([{ url: expect.stringMatching(/^https:\/\/scontent\.cdninstagram\.com\/o1\/.+\.mp4\?/), ext: 'mp4' }]);
  });

  it('says a post is gone only when the embed page says so too', () => {
    for (const code of ['ZZZZZZZZZZZ', 'Gone0000000']) {
      const { status, events } = run([code], 'empty');
      expect(status).toBe(1);
      expect(events).toEqual([{ type: 'error', error: expect.stringContaining('couldn’t find that post'), code: 'notfound' }]);
    }
  });

  it('says Instagram is turning the server away when the embed page doesn’t help either', () => {
    for (const [code, embed] of [['Df7E7GvG_2T', 'down'], ['Broken00000', 'up']] as const) {
      const { events } = run([code], 'empty', embed);
      expect(events).toEqual([{ type: 'error', error: expect.stringContaining('wouldn’t show that post to the server'), code: 'limited' }]);
    }
    // Instagram's own "please wait" stays as it was.
    expect(run(['Df7E7GvG_2T'], 'wait', 'down').events).toEqual([{ type: 'error', error: expect.stringContaining('limiting requests'), code: 'limited' }]);
  });

  it('doesn’t go round a sign-in problem', () => {
    expect(run(['Df7E7GvG_2T'], 'login').events).toEqual([{ type: 'error', error: expect.stringContaining('signed in'), code: 'login' }]);
  });

  it('skips the posts it can’t get and keeps the rest', () => {
    const { status, events } = run(['Dfy0nLPsmAq', 'ZZZZZZZZZZZ', 'Df7E7GvG_2T'], 'empty');
    expect(status).toBe(0);
    expect(events.map((e) => e.type)).toEqual(['post', 'skip', 'post', 'done']);
    expect(events[1]).toMatchObject({ target: 'ZZZZZZZZZZZ', code: 'notfound' });
  });
});

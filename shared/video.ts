// Video links in Server › Downloads: the sites whose links go to yt-dlp without asking, and the
// format choices. Used by the page (to say what will happen) and the server (to check what it's
// sent), so the two never disagree. Links to other sites go to yt-dlp when it knows the site.
import type { VideoFormat } from './types';

export type VideoSite = 'YouTube' | 'X' | 'TikTok' | 'Reddit' | 'SoundCloud';

export interface VideoLink {
  site: VideoSite;
  /** The link as yt-dlp gets it, with https:// if it was left off. */
  href: string;
  /** Only sound there (SoundCloud), so the video formats don't apply. */
  audio: boolean;
  /** 'only': the link is a playlist's (or a channel's), so its first video is taken; 'also': a video in a playlist, so just that video. */
  playlist: 'only' | 'also' | null;
}

export const VIDEO_FORMATS: { key: VideoFormat; label: string; audio: boolean }[] = [
  { key: 'best', label: 'Best', audio: true },
  { key: '1080p', label: '1080p MP4', audio: false },
  { key: 'mp3', label: 'MP3 audio', audio: true },
];

export function cleanVideoFormat(v: unknown): VideoFormat {
  return VIDEO_FORMATS.some((f) => f.key === v) ? (v as VideoFormat) : 'best';
}

const SITES: { site: VideoSite; host: RegExp }[] = [
  { site: 'YouTube', host: /^(?:(?:www|m|music)\.)?youtube\.com$|^youtu\.be$|^(?:www\.)?youtube-nocookie\.com$/ },
  { site: 'X', host: /^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/ },
  { site: 'TikTok', host: /^(?:(?:www|m|vm|vt)\.)?tiktok\.com$/ },
  { site: 'Reddit', host: /^(?:(?:www|old|new|np|m)\.)?reddit\.com$|^(?:v\.)?redd\.it$/ },
  { site: 'SoundCloud', host: /^(?:(?:www|m|on)\.)?soundcloud\.com$/ },
];

/** A link to one of the sites above (one line, http or https), with what it says about playlists; null for anything else. */
export function videoLink(text: string): VideoLink | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(t) ? t : /^[\w.-]+\.\w+\//.test(t) ? 'https://' + t : t);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const hit = SITES.find((s) => s.host.test(host));
  if (!hit) return null;
  const seg = u.pathname.split('/').filter(Boolean);
  let playlist: VideoLink['playlist'] = null;
  if (hit.site === 'YouTube') {
    const video = host === 'youtu.be' ? !!seg[0] : u.searchParams.has('v') || /^(shorts|live|embed|v|clip)$/.test(seg[0] ?? '');
    if (video) playlist = u.searchParams.has('list') ? 'also' : null;
    else if (seg[0] === 'playlist' || /^(@|channel$|c$|user$)/.test(seg[0] ?? '')) playlist = 'only';
  } else if (hit.site === 'SoundCloud' && host !== 'on.soundcloud.com') {
    // soundcloud.com/<artist>/sets/<set> is a playlist, and soundcloud.com/<artist> their tracks.
    if (seg[1] === 'sets' || (seg.length === 1 && !/^(discover|stream|search)$/.test(seg[0]))) playlist = 'only';
    else if (u.searchParams.has('in')) playlist = 'also';
  }
  return { site: hit.site, href: u.href, audio: hit.site === 'SoundCloud', playlist };
}

/**
 * Whether a POST to /api/downloads is for yt-dlp: when the page says so, and for the sites above
 * whatever it says, so a page from before videos (still open since the deploy) can't save YouTube's
 * watch page as a file called "watch".
 */
export function wantsVideo(body: { via?: unknown; url?: unknown } | null | undefined): boolean {
  if (body?.via === 'video') return true;
  return typeof body?.url === 'string' && !!videoLink(body.url);
}

/** What the page calls the thing a link is to. */
export function videoNoun(site: VideoSite): string {
  return site === 'SoundCloud' ? 'SoundCloud track' : site === 'X' ? 'post on X' : site === 'Reddit' ? 'Reddit video' : site === 'TikTok' ? 'TikTok' : 'YouTube video';
}

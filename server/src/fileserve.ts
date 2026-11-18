// Sending a server file to the browser: as a download, or inline for the preview,
// either way with HTTP Range so a video can seek and a download can resume.
//
// Inline is only for images (not SVG), PDFs, audio and video (shared/files.ts), and
// every inline response forbids sniffing and carries a sandboxing CSP. A file shown on
// Launchpad's own origin could otherwise run as a page with the whole API at hand:
// an uploaded .html, or an .svg with a script in it.
import { previewOf } from '../../shared/files';

export type Range = { start: number; end: number } | 'unsatisfiable' | null;

/**
 * The single byte range a Range header asks for, `end` inclusive; null to send the whole
 * file (no header, one that isn't bytes, or several ranges, which RFC 9110 lets a server
 * ignore); 'unsatisfiable' when it starts past the end (416).
 */
export function parseRange(header: string | undefined, size: number): Range {
  if (!header) return null;
  const m = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (size === 0) return m[1] ? 'unsatisfiable' : null;
  if (!m[1]) {
    // The last n bytes.
    const n = Number(m[2]);
    if (!n) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || start >= size) return 'unsatisfiable';
  if (end < start) return null;
  return { start, end };
}

/** A strong-enough validator for If-Range: the size and modified time, as SFTP gives them. */
export const etagOf = (size: number, mtime: number) => `"${size.toString(36)}-${mtime.toString(36)}"`;

/** Whether an If-Range lets the range through; any other validator means the file changed, so it's sent whole. */
export const ifRangeOk = (ifRange: string | undefined, etag: string) => !ifRange || ifRange.trim() === etag;

/**
 * For anything shown inline. The CSP gives the response an opaque origin and runs nothing
 * in it, so even if a browser did treat it as a page it couldn't reach the API. PDFs leave
 * the sandbox out: browsers refuse to show a PDF under one, and their viewers never run a
 * PDF's script on the page's origin anyway.
 */
export function inlineHeaders(name: string): Record<string, string> | null {
  const p = previewOf(name);
  if (!p) return null;
  return {
    'Content-Type': p.type,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': p.kind === 'pdf' ? "default-src 'none'; object-src 'self'" : "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
  };
}

export const downloadHeaders = (name: string): Record<string, string> => ({
  'Content-Type': 'application/octet-stream',
  'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
});

/** The status and headers for a whole file or the part of it asked for. */
export function rangeHeaders(size: number, part: Range, mtime: number): { status: 200 | 206 | 416; headers: Record<string, string> } {
  const common = { 'Accept-Ranges': 'bytes', ETag: etagOf(size, mtime), 'Last-Modified': new Date(mtime * 1000).toUTCString(), 'Cache-Control': 'private, no-cache' };
  if (part === 'unsatisfiable') return { status: 416, headers: { ...common, 'Content-Range': `bytes */${size}` } };
  if (!part) return { status: 200, headers: { ...common, 'Content-Length': String(size) } };
  return { status: 206, headers: { ...common, 'Content-Length': String(part.end - part.start + 1), 'Content-Range': `bytes ${part.start}-${part.end}/${size}` } };
}

// What the Files explorer and the server say to each other beyond a folder listing
// (shared/types.ts has DirListing): the trash, background jobs, search and previews.

/** Something in a trash folder, waiting to be restored or emptied. */
export interface TrashItem {
  /** The trash folder it's in: ~/.local/share/Trash, or <mount>/.Trash-<uid> on another disk. */
  trash: string;
  /** Its name in that trash's files folder. */
  id: string;
  /** Where it was, absolute. */
  path: string;
  /** ISO. */
  deletedAt: string;
  kind: 'dir' | 'file' | 'other';
  /** In bytes, for files; 0 for folders. */
  size: number;
  /** Launchpad put it there, so it's emptied for good TRASH_DAYS after. Others are left to whatever trashed them. */
  ours: boolean;
}

export interface TrashListing {
  items: TrashItem[];
  /** The trash folders looked in. */
  trashes: string[];
}

/** Days something Launchpad put in the trash stays there. */
export const TRASH_DAYS = 7;

/** What a delete did: what went to the trash, and what couldn't, with why. */
export interface TrashOutcome {
  /** Each one's place in the trash, in the order asked for, for an undo. */
  trashed: { path: string; trash: string; id: string }[];
  failed: { path: string; error: string; /** It could still be deleted for good. */ permanentOk: boolean }[];
}

export type FileJobKind = 'extract' | 'compress' | 'copy' | 'move' | 'empty' | 'delete';

/** Work that can take longer than a page request may (Cloudflare gives up after 100 seconds), done on the server while the page polls. */
export interface FileJob {
  id: string;
  kind: FileJobKind;
  /** "Unpacking photos.zip", say. */
  label: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  /** What it's doing now while running ("Checking the archive"), or how it ended. */
  message: string;
  /** The folder it works in, so the page can refresh it when the job ends. */
  dir: string;
  /** What it made, to go to when it's done: a folder or a file. */
  result?: string;
  startedAt: string;
  endedAt?: string;
}

export interface SearchHit {
  path: string;
  kind: 'dir' | 'file' | 'other';
  /** For a name search. */
  size?: number;
  /** For a contents search: the first matching line, and its number. */
  line?: number;
  text?: string;
}

/** The last line of a streamed search. */
export interface SearchEnd {
  done: true;
  count: number;
  /** Stopped at the result limit; there may be more. */
  more: boolean;
  /** Stopped at the time limit. */
  timedOut: boolean;
  tool: 'find' | 'grep' | 'rg';
  error?: string;
}

export const SEARCH_LIMIT = 500;
export const SEARCH_SECONDS = 30;
/** Bigger files are skipped by a contents search. */
export const SEARCH_MAX_FILE_MB = 20;

/** A folder's size from du: `partial` when some of it couldn't be read, so it's at least that. */
export interface FolderSize {
  bytes: number;
  partial: boolean;
}

export type PreviewKind = 'image' | 'audio' | 'video';

/**
 * Files the browser may show inline, by extension, with the type they're sent as.
 * Only types a browser never runs as a page: no HTML, no SVG (it can carry script), no XML.
 */
export const PREVIEW_TYPES: Record<string, { type: string; kind: PreviewKind }> = {
  png: { type: 'image/png', kind: 'image' },
  jpg: { type: 'image/jpeg', kind: 'image' },
  jpeg: { type: 'image/jpeg', kind: 'image' },
  gif: { type: 'image/gif', kind: 'image' },
  webp: { type: 'image/webp', kind: 'image' },
  avif: { type: 'image/avif', kind: 'image' },
  bmp: { type: 'image/bmp', kind: 'image' },
  ico: { type: 'image/x-icon', kind: 'image' },
  mp3: { type: 'audio/mpeg', kind: 'audio' },
  m4a: { type: 'audio/mp4', kind: 'audio' },
  aac: { type: 'audio/aac', kind: 'audio' },
  ogg: { type: 'audio/ogg', kind: 'audio' },
  oga: { type: 'audio/ogg', kind: 'audio' },
  opus: { type: 'audio/ogg', kind: 'audio' },
  wav: { type: 'audio/wav', kind: 'audio' },
  flac: { type: 'audio/flac', kind: 'audio' },
  weba: { type: 'audio/webm', kind: 'audio' },
  mp4: { type: 'video/mp4', kind: 'video' },
  m4v: { type: 'video/mp4', kind: 'video' },
  webm: { type: 'video/webm', kind: 'video' },
  mov: { type: 'video/quicktime', kind: 'video' },
  ogv: { type: 'video/ogg', kind: 'video' },
  mkv: { type: 'video/x-matroska', kind: 'video' },
};

/** How a file can be previewed, from its name; null for anything else. */
export function previewOf(name: string): { type: string; kind: PreviewKind } | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return (m && PREVIEW_TYPES[m[1].toLowerCase()]) || null;
}

export type ArchiveKind = 'zip' | 'tar' | '7z' | 'rar';

const ARCHIVE_EXTS: [RegExp, ArchiveKind][] = [
  [/\.(tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2?|tar\.zst|tzst|tar)$/i, 'tar'],
  [/\.zip$/i, 'zip'],
  [/\.7z$/i, '7z'],
  [/\.rar$/i, 'rar'],
];

/** An archive Launchpad can unpack, from its name, and the name without its extension (for the folder it unpacks into). */
export function archiveOf(name: string): { kind: ArchiveKind; stem: string } | null {
  for (const [re, kind] of ARCHIVE_EXTS) {
    const m = re.exec(name);
    if (m && m.index > 0) return { kind, stem: name.slice(0, m.index) };
  }
  return null;
}

/** "name (2).txt", "name (3).txt"… for the n-th try at a free name; n = 1 is the name itself. Two-part extensions like .tar.gz stay together. */
export function numberedName(name: string, n: number): string {
  if (n <= 1) return name;
  const m = /^(.+?)((\.tar)?\.[A-Za-z0-9]{1,5})?$/.exec(name);
  const stem = m?.[1] ?? name;
  const ext = m?.[2] ?? '';
  return `${stem} (${n})${ext}`;
}

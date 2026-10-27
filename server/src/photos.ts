// Photos for the dashboard's photo panels. The image files live in
// DATA_DIR/photos; their order and focus points are the "photos" doc in the store.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import type { Photo } from '../../shared/types';

export interface StoredPhoto extends Photo {
  mime: string;
}

/** The page shrinks big photos before uploading, so this only stops runaway files. */
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
export const MAX_PHOTOS = 60;

const dir = path.join(config.dataDir, 'photos');
fs.mkdirSync(dir, { recursive: true });

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** The image type from a file's first bytes, or null for anything but JPEG, PNG, WebP and GIF. */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return 'image/png';
  if (ascii(b, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Ids are generated here, so anything else is not a photo (and never reaches the file system). */
export const validPhotoId = (id: string) => /^[A-Za-z0-9_-]{16}$/.test(id);

export function writePhoto(bytes: Uint8Array, mime: string): StoredPhoto {
  const id = randomBytes(12).toString('base64url');
  fs.writeFileSync(path.join(dir, id), bytes);
  return { id, mime, focus: { x: 50, y: 30 } };
}

export function readPhoto(id: string): Buffer | null {
  if (!validPhotoId(id)) return null;
  try {
    return fs.readFileSync(path.join(dir, id));
  } catch {
    return null;
  }
}

export function removePhotoFile(id: string): void {
  if (validPhotoId(id)) fs.rmSync(path.join(dir, id), { force: true });
}

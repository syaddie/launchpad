// Housekeeping that runs in the background: photo files nothing uses, and the part
// files of uploads that were given up on without the page saying so.
import { sweepPhotos } from './photos';
import { sweepUploads } from './shell';
import { store } from './store';

const HOUR = 60 * 60_000;

function photos() {
  try {
    const before = store.photos();
    const { photos, removed } = sweepPhotos(before);
    if (photos.length !== before.length) store.setPhotos(photos);
    if (removed || photos.length !== before.length) console.log(`[cleanup] photos: removed ${removed} unused file(s), dropped ${before.length - photos.length} missing`);
  } catch (e) {
    console.error('[cleanup] photos:', (e as Error).message);
  }
}

async function uploads() {
  try {
    const n = await sweepUploads();
    if (n) console.log(`[cleanup] removed ${n} abandoned upload part file(s)`);
  } catch (e) {
    // The server's SSH may be down; the next run tries again.
    console.warn('[cleanup] uploads:', (e as Error).message);
  }
}

export function startCleanup(): void {
  setTimeout(() => {
    photos();
    uploads();
  }, 60_000);
  setInterval(photos, 24 * HOUR);
  setInterval(uploads, 6 * HOUR);
}

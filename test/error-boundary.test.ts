import { describe, expect, it } from 'vitest';
import { isChunkError } from '../web/src/components/ErrorBoundary';

describe('isChunkError', () => {
  it('recognises a bundle that is gone after a deploy', () => {
    expect(isChunkError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/Terminal-abc.js'))).toBe(true);
    expect(isChunkError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkError(new TypeError("Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of \"text/html\". is not a valid JavaScript MIME type"))).toBe(true);
  });

  it('leaves other errors alone', () => {
    expect(isChunkError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isChunkError('boom')).toBe(false);
  });
});

import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Importing server modules opens the database, so keep it out of the repo (test/setup.ts
    // gives each worker its own folder under this).
    env: { TZ: 'Asia/Singapore', DATA_DIR: path.join(os.tmpdir(), 'launchpad-test') },
    setupFiles: ['test/setup.ts'],
  },
});

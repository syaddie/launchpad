import os from 'node:os';
import path from 'node:path';

// Test files run in parallel workers, and importing a server module opens the database. Each
// worker gets a folder of its own, so two never open a new database at once and trip over
// each other switching it to WAL ("database is locked"). Tests that need a clean one still
// set DATA_DIR themselves before importing the store.
process.env.DATA_DIR = path.join(os.tmpdir(), `launchpad-test-${process.env.VITEST_POOL_ID ?? process.pid}`);

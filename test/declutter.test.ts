// Batch 4's declutter (docs/batch-4-layout-spec.md): buttons whose action is also in the thing's menu
// went, leaving the main action and a way in. The menus themselves were tried in the app.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ContainerInfo } from '../shared/types';
import { ContainerRow } from '../web/src/components/Containers';

const c: ContainerInfo = { id: 'a'.repeat(64), name: 'jellyfin', image: 'jellyfin/jellyfin', state: 'running', status: 'Up 3 days', self: false };

describe('a container row', () => {
  it('keeps Logs as its one button; Restart is in its menu and the logs', () => {
    const html = renderToStaticMarkup(createElement(ContainerRow, { c, canRestart: true, onLogs: () => {}, onRestarted: () => {} }));
    expect(html).toContain('aria-label="Logs of jellyfin"');
    expect(html).not.toMatch(/Restart/);
  });
});

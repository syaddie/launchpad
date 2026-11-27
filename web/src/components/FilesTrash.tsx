import { useCallback, useEffect, useState } from 'react';
import { TRASH_DAYS, type FileJob, type TrashItem, type TrashListing } from '../../../shared/files';
import { filesApi } from '../filesApi';
import { ago, fmtBytes } from '../util';
import { EmptyArt } from './mission/EmptyArt';

const nameOf = (p: string) => p.split('/').pop() || p;
const parentOf = (p: string) => p.replace(/\/[^/]*$/, '') || '/';

/** What's in the server's trash, to restore or delete for good. */
export function FilesTrash({ now, jobs, onJob, onClose }: {
  now: Date;
  /** Running and recent jobs, so the list reloads when an empty finishes. */
  jobs: FileJob[];
  onJob: (j: FileJob) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<TrashListing | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    filesApi
      .listTrash()
      .then((l) => {
        setListing(l);
        setError('');
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  // An empty or delete that just finished changes what's here.
  const emptying = jobs.some((j) => j.kind === 'empty' && j.state === 'running');
  const doneCount = jobs.filter((j) => j.kind === 'empty' && j.state !== 'running').length;
  useEffect(() => {
    if (doneCount) load();
  }, [doneCount, load]);

  const key = (i: TrashItem) => `${i.trash}\0${i.id}`;
  const mark = (items: TrashItem[], on: boolean) =>
    setBusy((b) => {
      const n = new Set(b);
      for (const i of items) (on ? n.add(key(i)) : n.delete(key(i)));
      return n;
    });

  const restore = (items: TrashItem[]) => {
    mark(items, true);
    setNotice('');
    filesApi
      .restore(items.map(({ trash, id }) => ({ trash, id })))
      .then((r) => {
        const renamed = r.restored.filter((x) => x.as !== x.path);
        const parts = [];
        if (r.restored.length === 1) parts.push(`Put ${nameOf(r.restored[0].path)} back in ${parentOf(r.restored[0].path)}.`);
        else if (r.restored.length) parts.push(`Put ${r.restored.length} things back where they were.`);
        if (renamed.length) parts.push(`${renamed.map((x) => `${nameOf(x.path)} came back as ${nameOf(x.as)}`).join(', ')}, since something else had its name.`);
        if (r.failed.length) parts.push(`Couldn’t restore ${r.failed.length === 1 ? r.failed[0].id : `${r.failed.length} things`}: ${r.failed[0].error}`);
        setNotice(parts.join(' '));
        load();
      })
      .catch((e: Error) => setNotice(`Couldn’t restore: ${e.message}`))
      .finally(() => mark(items, false));
  };

  const deleteForGood = (items: TrashItem[]) => {
    const what = items.length === 1 ? `“${nameOf(items[0].path)}”` : `${items.length} things`;
    if (!window.confirm(`Delete ${what} for good? This can’t be undone.`)) return;
    mark(items, true);
    filesApi
      .deleteFromTrash(items.map(({ trash, id }) => ({ trash, id })))
      .then((r) => onJob(r.job))
      .catch((e: Error) => {
        setNotice(`Couldn’t delete: ${e.message}`);
        mark(items, false);
      });
  };

  const empty = () => {
    if (!window.confirm('Delete everything in the trash for good? This can’t be undone.')) return;
    filesApi
      .emptyTrash()
      .then((r) => onJob(r.job))
      .catch((e: Error) => setNotice(`Couldn’t empty the trash: ${e.message}`));
  };

  const items = listing?.items ?? [];
  const daysLeft = (i: TrashItem) => Math.min(TRASH_DAYS, Math.max(0, Math.ceil(TRASH_DAYS - (now.getTime() - Date.parse(i.deletedAt)) / 86_400_000)));

  return (
    <>
      <div className="files-bar">
        <span>
          <i className="ph-duotone ph-trash" /> <strong>Trash</strong>
          <span className="meta"> · what Launchpad deletes is emptied {TRASH_DAYS} days later</span>
        </span>
        <span className="files-bar-tools">
          <button className="btn btn-secondary btn-small" disabled={!items.length || emptying} onClick={empty}>
            <i className={'ph-duotone ' + (emptying ? 'ph-circle-notch spin' : 'ph-broom')} />
            {emptying ? 'Emptying…' : 'Empty trash'}
          </button>
          <button className="btn btn-secondary btn-small" onClick={onClose}>
            Back to files
          </button>
        </span>
      </div>
      {(error || notice) && (
        <div className={error ? 'status-line' : 'files-notice meta'} style={{ margin: 0 }}>
          <i className={'ph-duotone ' + (error ? 'ph-warning' : 'ph-info')} /> {error || notice}
        </div>
      )}
      <div className="files-list scroll" role="list" aria-label="Trash">
        {!listing && !error && <div className="empty"><p>Looking in the trash…</p></div>}
        {listing && !items.length && (
          <div className="empty">
            <EmptyArt kind="clear" />
            <p>The trash is empty.</p>
          </div>
        )}
        {items.map((i) => (
          <div key={key(i)} className="file-row trash-row" role="listitem">
            <i className={'ph-duotone ' + (i.kind === 'dir' ? 'ph-folder-simple is-dir' : 'ph-file')} />
            <span className="trash-what">
              <span className="mono trash-name" title={i.path}>
                {nameOf(i.path)}
              </span>
              <span className="meta mono trash-from" title={parentOf(i.path)}>
                {parentOf(i.path)}
              </span>
              <span className="meta trash-when-inline">
                {ago(i.deletedAt, now)}
                {i.ours && ` · ${daysLeft(i) ? `${daysLeft(i)} d left` : 'goes soon'}`}
              </span>
            </span>
            <span className="meta tnum file-size">{i.kind === 'file' ? fmtBytes(i.size) : ''}</span>
            <span className="meta tnum file-when" title={new Date(i.deletedAt).toLocaleString()}>
              {ago(i.deletedAt, now)}
              {i.ours && <span className="trash-left"> · {daysLeft(i) ? `${daysLeft(i)} d left` : 'goes soon'}</span>}
            </span>
            <span className="file-actions trash-actions">
              <button className="btn btn-secondary btn-small" disabled={busy.has(key(i))} onClick={() => restore([i])} aria-label={`Restore ${nameOf(i.path)}`}>
                <i className="ph-duotone ph-arrow-counter-clockwise" />
                <span className="files-label">Restore</span>
              </button>
              <button className="icon-btn" title="Delete for good" aria-label={`Delete ${nameOf(i.path)} for good`} disabled={busy.has(key(i))} onClick={() => deleteForGood([i])}>
                <i className="ph-duotone ph-x" />
              </button>
            </span>
          </div>
        ))}
      </div>
      <div className="split meta files-foot">
        <span>{listing ? `${items.length} ${items.length === 1 ? 'thing' : 'things'} in the trash` : ''}</span>
        {listing && listing.trashes.length > 1 && <span>Each disk keeps its own trash, so nothing is copied between them</span>}
      </div>
    </>
  );
}

import { useCallback, useMemo, useRef, type RefObject } from 'react';
import { merge3, mergeNotes } from '../../../shared/merge';
import type { AppState, Note, SavedDoc } from '../../../shared/types';
import { api, ConflictError } from '../api';
import { useSaver, type Saver } from './useSaver';

export const SAVED_DOCS = ['bookmarks', 'notes', 'money', 'learn'] as const satisfies readonly SavedDoc[];

type Base = { value: unknown; version?: string };
export type Savers = { [K in SavedDoc]: Saver<AppState[K]> };

/**
 * The documents saved whole (bookmarks, notes, money, Learn), each with a debounced saver that
 * says which version its edits started from. If another tab or device saved first, this page's
 * edits are merged into their copy (shared/merge.ts) and saved on top of it.
 */
export function useSavers({ data, dataRef, update, notify, onError, onNotesSaved, onMoneySaved }: {
  data: AppState;
  /** The latest data, for saves that finish after more edits. */
  dataRef: RefObject<AppState>;
  update: (fn: (d: AppState) => AppState) => void;
  notify: (msg: string) => void;
  onError: (e: Error) => void;
  onNotesSaved: () => void;
  onMoneySaved: () => void;
}) {
  /** For each document saved whole, the server's copy this page's edits started from, and its version. */
  const bases = useRef<Record<SavedDoc, Base> | null>(null);
  bases.current ??= Object.fromEntries(SAVED_DOCS.map((k) => [k, { value: data[k], version: data.versions?.[k] }])) as Record<SavedDoc, Base>;

  /**
   * Save one document. If another tab or device saved it first, merge this page's edits
   * (all of them, including any made while the save was out) into their copy, show the
   * result, and hand it back to be saved on top of theirs.
   */
  const saveDoc = useCallback(
    <K extends SavedDoc>(key: K) =>
      async (v: AppState[K], { keepalive, unchecked }: { keepalive: boolean; unchecked: boolean }): Promise<AppState[K] | void> => {
        const base = bases.current![key];
        try {
          const { version } = await api.putDoc(key, v, unchecked ? undefined : base?.version, keepalive);
          bases.current![key] = { value: v, version };
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e;
          const mine = dataRef.current[key];
          const theirs = e.value as AppState[K];
          const { value, conflicts, copies = 0 } = key === 'notes'
            ? (mergeNotes(base?.value as Note[], mine as Note[], theirs as Note[]) as { value: AppState[K]; conflicts: number; copies: number })
            : { ...merge3(base?.value as AppState[K], mine, theirs), copies: 0 };
          bases.current![key] = { value: theirs, version: e.version };
          update((d) => ({ ...d, [key]: value }));
          notify(
            `Merged with changes made on another device${copies ? '; its version of a notepad you both edited is kept as a copy' : ''}${conflicts ? ` (${conflicts} edit${conflicts === 1 ? '' : 's'} you both made: yours kept)` : ''}.`,
          );
          return value;
        }
      },
    [dataRef, update, notify],
  );
  const saveBookmarks = useMemo(() => saveDoc('bookmarks'), [saveDoc]);
  const saveNotes = useMemo(() => saveDoc('notes'), [saveDoc]);
  const saveMoney = useMemo(() => saveDoc('money'), [saveDoc]);
  const saveLearn = useMemo(() => saveDoc('learn'), [saveDoc]);
  const bookmarks = useSaver(saveBookmarks, 400, undefined, onError);
  const money = useSaver(saveMoney, 500, onMoneySaved, onError);
  const notes = useSaver(saveNotes, 500, onNotesSaved, onError);
  const learn = useSaver(saveLearn, 400, undefined, onError);
  const savers: Savers = useMemo(() => ({ bookmarks, notes, money, learn }), [bookmarks, notes, money, learn]);

  /** The server's copy of a document is now where the next save of it starts. */
  const setBase = useCallback((key: SavedDoc, value: unknown, version: string | undefined) => {
    bases.current![key] = { value, version };
  }, []);

  return { savers, setBase };
}

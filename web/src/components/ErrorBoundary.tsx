import { Component, type ReactNode } from 'react';

/**
 * A lazy view's file couldn't be fetched. After a deploy the hashed bundles are renamed, so a tab opened
 * before it asks for files that no longer exist (the browser reports that as a failed dynamic import,
 * or a MIME error when something answered with a page instead).
 */
export function isChunkError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /ChunkLoadError|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|is not a valid JavaScript MIME type/i.test(msg);
}

/**
 * Keeps a failure in one part of the page from blanking all of it: React unmounts the whole tree on an
 * error nothing catches. Shows what happened with a way out, and tries again when `resetKey` changes.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string; label?: string }, { error: Error | null; key?: string }> {
  state: { error: Error | null; key?: string } = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { error: Error | null; key?: string }) {
    return props.resetKey === state.key ? null : { error: null, key: props.resetKey };
  }

  componentDidCatch(error: Error) {
    console.error('[ui]', error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = isChunkError(error);
    return (
      <section className="panel srv-panel">
        <div className="empty" role="alert">
          <p>{stale ? 'Launchpad was updated since this tab opened.' : `${this.props.label ?? 'This view'} hit a problem: ${error.message}`}</p>
          <button className="btn btn-primary btn-small" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </section>
    );
  }
}

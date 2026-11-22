import { createElement, lazy, useState, type ComponentType } from 'react';

/**
 * A component whose code is fetched the first time it's needed, as with React's `lazy`, but which
 * renders straight away, without Suspense's placeholder, once its code is in. Preloading one makes
 * opening it instant, and the change of view (motion.css) then animates to the view itself rather
 * than to a blank placeholder that's replaced a moment later.
 */
export function loadable<P extends object>(load: () => Promise<ComponentType<P>>) {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const preload = () =>
    (pending ??= load().then(
      (c) => (loaded = c),
      (e: unknown) => {
        // A failed fetch (offline, or a deploy replaced the file) can be tried again.
        pending = null;
        throw e;
      },
    ));
  const Lazy = lazy(() => preload().then((c) => ({ default: c })));
  function Loadable(props: P) {
    // Each instance keeps to the way it started, so a view that began on the placeholder isn't
    // remounted (and its state lost) when the code arrives.
    const [Direct] = useState(() => loaded);
    return Direct ? createElement(Direct, props) : createElement(Lazy as unknown as ComponentType<P>, props);
  }
  return Object.assign(Loadable, { preload, ready: () => loaded !== null });
}

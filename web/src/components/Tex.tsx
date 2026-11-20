// Text with maths in it, rendered with KaTeX: LaTeX between $…$ in a sentence, $$…$$ on a line
// of its own (shared/math.ts finds it). LaTeX KaTeX can't read is shown as it was written.
// KaTeX escapes what it's given and `trust` is off, so its HTML is safe to put in the page.
import { Fragment, memo, useLayoutEffect, useMemo, useRef } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { splitMath } from '../../../shared/math';

const cache = new Map<string, string | null>();

function render(tex: string, display: boolean): string | null {
  const key = (display ? 'D' : 'I') + tex;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let html: string | null;
  try {
    html = katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: 'ignore', trust: false, maxExpand: 500, maxSize: 20 });
  } catch {
    html = null;
  }
  if (cache.size > 800) cache.clear();
  cache.set(key, html);
  return html;
}

/** Fractions in a sentence come out tiny in text style: they're set full size, as on their own line. */
const sized = (tex: string, display: boolean) => (!display && /\\(?:frac|sum|prod|int)(?![a-zA-Z])/.test(tex) ? `\\displaystyle ${tex}` : tex);

/** Display maths can't wrap: one wider than its box is set smaller to fit (down to 60%), and only what's still too wide scrolls. */
function DisplayMath({ html }: { html: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = -1;
    const fit = () => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      el.style.fontSize = '';
      const over = el.scrollWidth / Math.max(1, el.clientWidth);
      if (over > 1.01) el.style.fontSize = `${Math.round(Math.max(0.6, 1 / over) * 100)}%`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [html]);
  return <span ref={ref} className="tex tex-display" dangerouslySetInnerHTML={{ __html: html }} />;
}

function MathSpan({ tex, display }: { tex: string; display: boolean }) {
  const html = render(sized(tex, display), display);
  if (html === null) return <code className="tex-raw">{display ? `$$${tex}$$` : `$${tex}$`}</code>;
  if (display) return <DisplayMath html={html} />;
  return <span className="tex" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** `text` with its maths rendered. */
export const Tex = memo(function Tex({ text }: { text: string }) {
  const parts = useMemo(() => splitMath(text), [text]);
  return (
    <>
      {parts.map((p, i) => (p.kind === 'text' ? <Fragment key={i}>{p.value}</Fragment> : <MathSpan key={i} tex={p.value} display={p.kind === 'display'} />))}
    </>
  );
});

/** A formula on its own, as display maths: `tex` is LaTeX without dollar signs. */
export const Formula = memo(function Formula({ tex }: { tex: string }) {
  return <MathSpan tex={tex} display />;
});

// Maths in the digest's text: LaTeX between $…$ (or \(…\)) in a sentence, and on a line of
// its own between $$…$$ (or \[…\]). The page renders it with KaTeX (web/src/components/Tex.tsx);
// this finds it, carefully enough that prices such as "$5 and $10" stay text.

export type MathPart = { kind: 'text' | 'inline' | 'display'; value: string };

const space = (c: string | undefined) => c === undefined || /\s/.test(c);

/**
 * Text split into plain text and maths. `$…$` is maths only when the opening `$` is followed by
 * something other than a space, and the closing one comes after something other than a space and
 * isn't followed by a digit, on the same line (as Pandoc reads it). A `$` that can't close it
 * leaves the opening one as text, so "$5 and $10" is a price. `\$` is a dollar sign.
 */
export function splitMath(s: string): MathPart[] {
  const out: MathPart[] = [];
  let text = '';
  const push = (kind: 'inline' | 'display', value: string) => {
    if (text) out.push({ kind: 'text', value: text });
    text = '';
    out.push({ kind, value });
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '$') {
      text += '$';
      i += 2;
      continue;
    }
    if (c === '\\' && (s[i + 1] === '(' || s[i + 1] === '[')) {
      const end = s.indexOf(s[i + 1] === '(' ? '\\)' : '\\]', i + 2);
      if (end > i + 2 && s.slice(i + 2, end).trim()) {
        push(s[i + 1] === '(' ? 'inline' : 'display', s.slice(i + 2, end).trim());
        i = end + 2;
        continue;
      }
    }
    if (c === '$' && s[i + 1] === '$') {
      const end = s.indexOf('$$', i + 2);
      if (end > i + 2 && s.slice(i + 2, end).trim()) {
        push('display', s.slice(i + 2, end).trim());
        i = end + 2;
        continue;
      }
      text += '$$';
      i += 2;
      continue;
    }
    if (c === '$' && !space(s[i + 1])) {
      let close = -1;
      for (let j = i + 1; j < s.length; j++) {
        if (s[j] === '\n') break;
        if (s[j] === '\\') {
          j++;
          continue;
        }
        if (s[j] === '$') {
          if (!space(s[j - 1]) && !/\d/.test(s[j + 1] ?? '')) close = j;
          break;
        }
      }
      if (close > i + 1) {
        push('inline', s.slice(i + 1, close));
        i = close + 1;
        continue;
      }
    }
    text += c;
    i++;
  }
  if (text) out.push({ kind: 'text', value: text });
  return out;
}

/** Whether there's any maths in the text. */
export const hasMath = (s: string) => splitMath(s).some((p) => p.kind !== 'text');

// LaTeX commands that a lost backslash in JSON turns into a tab or a new line, without their
// first letter (the escape took it): "\times" comes as "\t" + "imes", "\nabla" as "\n" + "abla".
// Only these, so a real tab or line break stays.
const TAB_CMDS = 'imes|heta|au|ext|extbf|extit|extrm|frac|ilde|an|anh|o|op|riangle|herefore|ag';
const NL_CMDS = 'abla|eq|e|u|otin|eg|leq|geq|mid|ewline';

/**
 * LaTeX as Claude meant it. In JSON, "\f", "\b", "\t", "\n" and "\r" are escapes, so a
 * backslash not doubled turns "\frac" into a form feed and "rac". Form feeds and backspaces are
 * never meant, nor is a carriage return before a letter; a tab or a new line is put back only
 * before a LaTeX command's name, and only in text with maths in it (or in `formula`, which is
 * all LaTeX).
 */
export function repairTex(s: string, formula = false): string {
  let t = s.replace(/\f/g, '\\f').replace(/\x08/g, '\\b').replace(/\r(?=[a-zA-Z])/g, '\\r').replace(/\r/g, '');
  if (formula) return t.replace(/[\t\n](?=[a-zA-Z])/g, (m) => (m === '\t' ? '\\t' : '\\n')).replace(/[\t\n]/g, ' ');
  if (!t.includes('$') && !t.includes('\\(') && !t.includes('\\[')) return t;
  t = t.replace(new RegExp(`\\t(?=(?:${TAB_CMDS})(?![a-zA-Z]))`, 'g'), '\\t');
  return t.replace(new RegExp(`\\n(?=(?:${NL_CMDS})(?![a-zA-Z]))`, 'g'), '\\n');
}

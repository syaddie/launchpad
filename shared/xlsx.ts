// Just enough of the .xlsx format to read cell values: unzip with the platform's
// DecompressionStream (browsers and Node 18+), then pick the cells out of each
// sheet's XML. Cached formula results are read as values; nothing is evaluated.

export interface XCell {
  v: string | number | boolean | null;
  /** The cell holds a formula (v is its last calculated result). */
  formula: boolean;
  /** A number shown with a date format, i.e. an Excel date serial. */
  date: boolean;
}

export interface XSheet {
  name: string;
  /** Keyed by "row:col", both from 1. */
  cells: Map<string, XCell>;
}

async function unzip(buf: ArrayBuffer): Promise<Map<string, () => Promise<string>>> {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('That isn’t an Excel (.xlsx) file.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = new Map<string, () => Promise<string>>();
  for (let i = 0; i < count && view.getUint32(p, true) === 0x02014b50; i++) {
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const skip = nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.slice(start, start + size);
    files.set(name, async () => {
      if (method === 0) return new TextDecoder().decode(data);
      if (method !== 8) throw new Error(`Unsupported compression in ${name}`);
      const out = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(out).text();
    });
    p += 46 + skip;
  }
  return files;
}

const unescape = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()],
  );

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
/** All the text runs in a shared or inline string, skipping phonetic hints. */
const runs = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1])).join('');

function colNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

/** Built-in date and time formats, and custom ones with d, m, y, h or s outside quotes and [brackets]. */
function dateStyles(styles: string): boolean[] {
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) custom.set(Number(attr(m[0], 'numFmtId')), unescape(attr(m[0], 'formatCode') || ''));
  const xfs = styles.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/)?.[0] || '';
  return [...xfs.matchAll(/<xf\b[^>]*>/g)].map((m) => {
    const id = Number(attr(m[0], 'numFmtId') || 0);
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true;
    const code = custom.get(id);
    return !!code && /[dmyhs]/i.test(code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, ''));
  });
}

/** The workbook's sheets in tab order, with every cell that has a value. */
export async function readXlsx(buf: ArrayBuffer): Promise<XSheet[]> {
  const files = await unzip(buf);
  const read = (name: string) => files.get(name)?.() ?? Promise.resolve('');
  const [workbook, rels, shared, styles] = await Promise.all([read('xl/workbook.xml'), read('xl/_rels/workbook.xml.rels'), read('xl/sharedStrings.xml'), read('xl/styles.xml')]);
  if (!workbook) throw new Error('That isn’t an Excel (.xlsx) file.');
  const strings = [...shared.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => runs(m[1]));
  const isDate = dateStyles(styles);
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) targets.set(attr(m[0], 'Id')!, attr(m[0], 'Target')!);

  const sheets: XSheet[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const target = targets.get(attr(m[0], 'r:id') || '');
    if (!target) continue;
    const xml = await read(target.startsWith('/') ? target.slice(1) : 'xl/' + target);
    const data = xml.match(/<sheetData\b[\s\S]*?<\/sheetData>/)?.[0] || '';
    const cells = new Map<string, XCell>();
    for (const c of data.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const [, attrs, inner = ''] = c;
      const ref = attr(attrs, 'r')?.match(/^([A-Z]+)(\d+)$/);
      if (!ref) continue;
      const type = attr(attrs, 't') || 'n';
      const raw = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let v: XCell['v'] = null;
      if (type === 'inlineStr') v = runs(inner);
      else if (raw === undefined || type === 'e') v = null;
      else if (type === 's') v = strings[Number(raw)] ?? '';
      else if (type === 'str') v = unescape(raw);
      else if (type === 'b') v = raw === '1';
      else v = Number(raw);
      if (v === null || v === '') continue;
      cells.set(`${ref[2]}:${colNumber(ref[1])}`, { v, formula: /<f\b/.test(inner), date: typeof v === 'number' && !!isDate[Number(attr(attrs, 's') || 0)] });
    }
    sheets.push({ name: unescape(attr(m[0], 'name') || ''), cells });
  }
  return sheets;
}

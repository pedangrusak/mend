// main.ts is mend, the CLI SPEC.md specifies (the kit's starting point, MIT, did sections 1 to 4, 9 and 10).
// The rest is implemented below: matching lines at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and the `R` line the output owes a move
// (section 2). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made, new path -> old path, for the `R` output line (section 2). */
  readonly moves = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One body line of a hunk, chunk or block: ' ' context, '-' old, '+' new, '\\' the no-newline marker. */
type Item = { t: string; text: string; raw?: string };

/** A file's own line break, lines and final-break flag (section 3). */
function splitFile(text: string): { br: string; lines: string[]; fin: boolean } {
  if (text === '') return { br: '\n', lines: [], fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const fin = text.endsWith(br);
  if (fin) lines.pop();
  return { br, lines, fin };
}
function joinFile(lines: string[], br: string, fin: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (fin ? br : '');
}

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}
/** Every start position at or after `from` where O's lines match the file's lines at `tier` (section 5). */
function occurrencesAt(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) if (!lineEq(lines[i + j]!, O[j]!, tier)) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}
/** The first tier with an occurrence of O at or after `from`, and its occurrences there. With
 *  `eofOnly`, only occurrences ending at the file's last line count (a V4A end-of-file chunk). */
function matchO(lines: string[], O: string[], strict: boolean, from: number, eofOnly = false): { tier: number; at: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    let at = occurrencesAt(lines, O, tier, from);
    if (eofOnly) at = at.filter((s) => s + O.length === lines.length);
    if (at.length > 0) return { tier, at };
  }
  return null;
}
/** The lines a matched chunk writes: context lines are the file's own matched lines; at tier 2 the
 *  other new lines are re-indented from O's first line's indent to the file's (section 5). */
function buildN(items: Item[], fileLines: string[], start: number, tier: number): string[] {
  const out: string[] = [];
  let oi = 0;
  let F = '';
  let P = '';
  if (tier === 2) {
    F = /^[ \t]*/.exec(fileLines[start] ?? '')![0];
    const firstO = items.find((it) => it.t === ' ' || it.t === '-');
    P = firstO ? /^[ \t]*/.exec(firstO.text)![0] : '';
  }
  for (const it of items) {
    if (it.t === ' ') { out.push(fileLines[start + oi]!); oi++; }
    else if (it.t === '-') oi++;
    else if (it.t === '+') {
      let s = it.text;
      if (tier === 2 && s.trim() !== '' && s.startsWith(P)) s = F + s.slice(P.length);
      out.push(s);
    }
  }
  return out;
}
/** True when a `\` line follows the body's last context or `+` line (sections 6's final-break rule). */
function backslashAfterLast(items: Item[]): boolean {
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k]!.t === ' ' || items[k]!.t === '+') return items[k + 1]?.t === '\\';
  }
  return false;
}

// ---------- section 6: unified diffs ----------

type Hunk = { a: number; items: Item[] };
type Section = {
  gitOld?: string; gitNew?: string;
  oldPath?: string | null; newPath?: string | null; pairSeen: boolean;
  renameFrom?: string; renameTo?: string;
  newFile: boolean; delFile: boolean;
  hunks: Hunk[];
};
const newSection = (): Section => ({ pairSeen: false, newFile: false, delFile: false, hunks: [] });

/** The path a `--- ` or `+++ ` line names: after the four characters, to the first tab, trimmed,
 *  `/dev/null` as null, a leading `a/` or `b/` removed. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairSeen ? sec.oldPath : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
    const newP = sec.pairSeen ? sec.newPath : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
    if (typeof oldP === 'string' && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (typeof newP === 'string' && !safe(newP)) throw new Fail('unsafe', newP);
    const creation = sec.newFile || oldP === null;
    const deletion = sec.delFile || newP === null;
    if (creation && typeof newP === 'string') {
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let trailing = true;
      for (const h of sec.hunks) {
        h.items.forEach((it, k) => {
          if (it.t === '+') { plus.push(it.text); trailing = h.items[k + 1]?.t !== '\\'; }
        });
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (trailing ? '\n' : ''));
      return;
    }
    if (deletion && typeof oldP === 'string') {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const src = oldP as string;
    const dst = newP as string;
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (dst !== src && tree.get(dst) !== null) throw new Fail('exists', dst);
    const st = splitFile(before);
    const lines = st.lines;
    let fin = st.fin;
    let d = 0;
    for (const h of sec.hunks) {
      const O = h.items.filter((it) => it.t === ' ' || it.t === '-').map((it) => it.text);
      const nLen = h.items.filter((it) => it.t === ' ' || it.t === '+').length;
      if (O.length === 0) {
        const add = h.items.filter((it) => it.t === '+').map((it) => it.text);
        const pos = Math.min(h.a + d, lines.length);
        const atEnd = pos === lines.length;
        lines.splice(pos, 0, ...add);
        if (atEnd) fin = !backslashAfterLast(h.items);
        d += add.length;
      } else {
        const m = matchO(lines, O, strict, 0);
        if (!m) throw new Fail('no-match', src);
        const hint = h.a - 1 + d;
        let start = m.at[0]!;
        for (const cand of m.at) if (Math.abs(cand - hint) < Math.abs(start - hint)) start = cand;
        const rep = buildN(h.items, lines, start, m.tier);
        const touchesEnd = start + O.length === lines.length;
        lines.splice(start, O.length, ...rep);
        if (touchesEnd) fin = !backslashAfterLast(h.items);
        d += nLen - O.length;
      }
    }
    tree.now.set(dst, joinFile(lines, st.br, fin));
    if (dst !== src) { tree.now.set(src, null); tree.moves.set(dst, src); }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let i = 0;
  const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice(11);
      const cut = rest.lastIndexOf(' b/');
      if (!rest.startsWith('a/') || cut < 2) throw new Exit2(`error: parse ${i + 1}`);
      sec = newSection();
      sec.gitOld = rest.slice(2, cut);
      sec.gitNew = rest.slice(cut + 3);
      sections.push(sec);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK.exec(line);
      if (!sec || !m) throw new Exit2(`error: parse ${i + 1}`);
      const items: Item[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const L = lines[j]!;
        if (L.startsWith('diff --git ')) break;
        if (L.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (L === '') items.push({ t: ' ', text: '', raw: '' });
        else if (L[0] === ' ' || L[0] === '-' || L[0] === '+' || L[0] === '\\') items.push({ t: L[0], text: L.slice(1), raw: L });
        else break;
        j++;
      }
      while (items.length && items[items.length - 1]!.raw === '') items.pop();
      sec.hunks.push({ a: Number(m[1]), items });
      i = j;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (!next.startsWith('+++ ')) {
        if (sec && sec.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
        i++;
        continue;
      }
      if (!sec || sec.hunks.length > 0 || sec.pairSeen) { sec = newSection(); sections.push(sec); }
      sec.oldPath = headerPath(line);
      sec.newPath = headerPath(next);
      sec.pairSeen = true;
      i += 2;
      continue;
    }
    if (sec && sec.hunks.length === 0) {
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice(12);
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice(10);
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.delFile = true;
    }
    i++;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = splitFile(before);
    const m = matchO(st.lines, oldLines, strict, 0);
    if (!m) throw new Fail('no-match', path);
    if (m.at.length > 1) throw new Fail('ambiguous', path);
    const start = m.at[0]!;
    const items: Item[] = [
      ...oldLines.map((t) => ({ t: '-', text: t })),
      ...newLines.map((t) => ({ t: '+', text: t })),
    ];
    const rep = buildN(items, st.lines, start, m.tier);
    const out = [...st.lines];
    out.splice(start, oldLines.length, ...rep);
    tree.now.set(path, joinFile(out, st.br, st.fin));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const at = i;
    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const L = lines[j]!.trimEnd();
      if (L === '=======' && eq < 0) eq = j;
      else if (L === '>>>>>>> REPLACE') {
        if (eq < 0) throw new Exit2(`error: parse ${at + 1}`);
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${at + 1}`);
    let path: string | null = null;
    for (let j = at - 1; j > prevEnd; j--) {
      const L = lines[j]!;
      if (blank(L) || L.trim().startsWith('```')) continue;
      path = L.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${at + 1}`);
    }
    edits.push(srEdit(path, lines.slice(at + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------- section 8: V4A patches ----------

type Chunk = { anchor: string | null; eof: boolean; items: Item[] };
type RawLine = { text: string; no: number };

function v4aAdd(path: string, raw: RawLine[]): Edit {
  const content: string[] = [];
  for (const r of raw) {
    if (r.text.startsWith('+')) content.push(r.text.slice(1));
    else if (r.text === '') content.push('');
    else throw new Exit2(`error: parse ${r.no}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
  };
}

function v4aUpdate(path: string, raw: RawLine[], secLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice(13).trim();
    idx = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (; idx < raw.length; idx++) {
    const r = raw[idx]!;
    const L = r.text;
    if (L.startsWith('@@')) {
      cur = { anchor: L.slice(2).trim() || null, eof: false, items: [] };
      chunks.push(cur);
    } else if (L.trim() === '*** End of File') {
      if (!cur) { cur = { anchor: null, eof: true, items: [] }; chunks.push(cur); }
      cur.eof = true;
      cur = null;
    } else if (L.startsWith('*** Move to: ')) {
      throw new Exit2(`error: parse ${r.no}`);
    } else if (L === '' || L[0] === ' ' || L[0] === '-' || L[0] === '+') {
      if (!cur) { cur = { anchor: null, eof: false, items: [] }; chunks.push(cur); }
      cur.items.push({ t: L === '' ? ' ' : L[0]!, text: L === '' ? '' : L.slice(1) });
    } else {
      throw new Exit2(`error: parse ${r.no}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const st = splitFile(before);
    const lines = st.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          for (let j = cursor; j < lines.length; j++) if (lineEq(lines[j]!, ch.anchor, tier)) { found = j; break; }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const O = ch.items.filter((it) => it.t !== '+').map((it) => it.text);
      if (O.length === 0) {
        const add = ch.items.filter((it) => it.t === '+').map((it) => it.text);
        const pos = ch.eof ? lines.length : Math.min(cursor, lines.length);
        lines.splice(pos, 0, ...add);
        cursor = pos + add.length;
      } else {
        const m = matchO(lines, O, strict, cursor, ch.eof);
        if (!m) throw new Fail('no-match', path);
        const start = m.at[0]!;
        const rep = buildN(ch.items, lines, start, m.tier);
        lines.splice(start, O.length, ...rep);
        cursor = start + rep.length;
      }
    }
    const dst = moveTo ?? path;
    tree.now.set(dst, joinFile(lines, st.br, st.fin));
    if (moveTo !== null) { tree.now.set(path, null); tree.moves.set(moveTo, path); }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) if (!blank(lines[j])) { last = j; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = (L: string): string | null =>
    L.startsWith('*** Add File: ') ? 'add' : L.startsWith('*** Delete File: ') ? 'del' : L.startsWith('*** Update File: ') ? 'upd' : null;
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const L = lines[i]!;
    if (blank(L)) { i++; continue; }
    const kind = secStart(L);
    if (!kind) throw new Exit2(`error: parse ${i + 1}`);
    const path = L.slice(L.indexOf(': ') + 2).trim();
    const secLine = i + 1;
    i++;
    const raw: RawLine[] = [];
    while (i < last && !secStart(lines[i]!)) { raw.push({ text: lines[i]!, no: i + 1 }); i++; }
    while (raw.length && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') edits.push(v4aAdd(path, raw));
    else if (kind === 'del') {
      if (raw.length) throw new Exit2(`error: parse ${raw[0]!.no}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else edits.push(v4aUpdate(path, raw, secLine, strict));
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? srEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows: { key: string; text: string }[] = [];
  const consumed = new Set<string>();
  for (const [np, op] of tree.moves) {
    if (tree.original(op) !== null && tree.now.get(op) === null && tree.original(np) === null && tree.now.get(np) !== null) {
      rows.push({ key: np, text: `R ${op} -> ${np}` });
      consumed.add(op);
      consumed.add(np);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

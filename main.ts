// mend: one patch tool for every AI edit format. SPEC.md is the whole contract.
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
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

/** A file as lines: its own line break, its lines, whether it ends with a line break. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** A line as a tier compares it: exact, trailing spaces and tabs off, both sides off. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at or after `from` where O's lines match the file's at this tier. */
function findOccurrences(file: string[], o: string[], tier: number, from = 0): number[] {
  const occ: number[] = [];
  if (o.length === 0) return occ;
  const keys = o.map((l) => tierKey(l, tier));
  for (let i = from; i + o.length <= file.length; i++) {
    let good = true;
    for (let j = 0; j < o.length; j++) {
      if (tierKey(file[i + j]!, tier) !== keys[j]) {
        good = false;
        break;
      }
    }
    if (good) occ.push(i);
  }
  return occ;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs, and where. */
function matchTier(file: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(file, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk: context, old, or new. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

/** A body's old lines O and new lines N, with each N line's index in O when it is a context line. */
function bodyON(body: BodyLine[]): { o: string[]; n: string[]; nCtx: (number | null)[] } {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: (number | null)[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      nCtx.push(o.length);
      o.push(b.text);
      n.push(b.text);
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else {
      nCtx.push(null);
      n.push(b.text);
    }
  }
  return { o, n, nCtx };
}

/** N written over a match: context lines are the file's own matched lines; at tier 2 the other lines are
 *  re-indented from O's first line to the file's first matched line. */
function renderN(file: string[], at: number, o: string[], n: string[], nCtx: (number | null)[], tier: number): string[] {
  if (o.length === 0) return [...n];
  if (tier !== 2) return n.map((l, i) => (nCtx[i] !== null ? file[at + nCtx[i]!]! : l));
  const f = leadingWs(file[at] ?? '');
  const p = leadingWs(o[0] ?? '');
  return n.map((l, i) => {
    if (nCtx[i] !== null) return file[at + nCtx[i]!]!;
    if (l === '' || l.trim() === '') return l;
    if (l.startsWith(p)) return f + l.slice(p.length);
    return l;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk.
 *  `moves` holds the moves that succeeded, for the R lines of the output. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; neu: string }[] = [];
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

/** A unified hunk: its old start line (1-based) and its body lines. */
interface Hunk {
  a: number;
  body: string[];
}

/** A unified hunk's body as BodyLines, and whether a `\` line follows its last context or `+` line. */
function hunkBody(body: string[]): { lines: BodyLine[]; backslashAfterLast: boolean } {
  const lines: BodyLine[] = [];
  let lastCtxOrPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l.startsWith(' ')) {
      lines.push({ kind: 'ctx', text: l.slice(1) });
      lastCtxOrPlus = k;
    } else if (l.startsWith('-')) lines.push({ kind: 'old', text: l.slice(1) });
    else if (l.startsWith('+')) {
      lines.push({ kind: 'new', text: l.slice(1) });
      lastCtxOrPlus = k;
    } else if (l === '') {
      lines.push({ kind: 'ctx', text: '' });
      lastCtxOrPlus = k;
    }
    // a `\` line refers to the body line before it and holds no text of its own
  }
  const backslashAfterLast = lastCtxOrPlus >= 0 && (body[lastCtxOrPlus + 1] ?? '').startsWith('\\');
  return { lines, backslashAfterLast };
}

/** One hunk applied to a file's lines. `d` is the length drift of this section's hunks applied so far. */
function applyHunk(state: FileState, hunk: Hunk, strict: boolean, d: number, path: string): FileState {
  const { lines, backslashAfterLast } = hunkBody(hunk.body);
  const { o, n, nCtx } = bodyON(lines);
  if (o.length === 0) {
    const at = Math.max(0, Math.min(hunk.a + d, state.lines.length));
    const out = [...state.lines.slice(0, at), ...n, ...state.lines.slice(at)];
    const final = at === state.lines.length ? !backslashAfterLast : state.final;
    return { lines: out, br: state.br, final };
  }
  const m = matchTier(state.lines, o, strict);
  if (m === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = m.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of m.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const rendered = renderN(state.lines, best, o, n, nCtx, m.tier);
  const out = [...state.lines.slice(0, best), ...rendered, ...state.lines.slice(best + o.length)];
  const final = best + o.length === state.lines.length ? !backslashAfterLast : state.final;
  return { lines: out, br: state.br, final };
}

interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  pairSeen: boolean;
  hadHunk: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: after the four characters, up to the first tab, spaces removed. */
function unifiedPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunkHeader(line: string, i: number): Hunk {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  return { a: parseInt(m[1]!, 10), body: [] };
}

/** The body after a hunk header: body lines, with empty lines at its end not part of it. Returns the next index. */
function collectHunkBody(lines: string[], i: number, hunk: Hunk): number {
  const body: string[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    // A `--- ` line followed by a `+++ ` line, and a `diff --git ` line, end the body, not continue it.
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('diff --git ') || l === 'diff --git') break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      i++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  hunk.body = body;
  return i;
}

function sectionToEdit(s: UnifiedSection, strict: boolean): Edit {
  const oldPath = s.pairOld !== undefined ? s.pairOld : (s.renameFrom ?? s.gitOld);
  const newPath = s.pairNew !== undefined ? s.pairNew : (s.renameTo ?? s.gitNew);
  const isCreate = oldPath === null || s.newFile;
  const isDelete = !isCreate && (newPath === null || s.deletedFile);
  if (isCreate) {
    const p = newPath;
    return (tree) => {
      if (p === null) throw new Fail('unsafe', '/dev/null');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let backslashAfterLast = false;
      for (const h of s.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const l = h.body[k]!;
          if (l.startsWith('+')) {
            plus.push(l.slice(1));
            backslashAfterLast = (h.body[k + 1] ?? '').startsWith('\\');
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (backslashAfterLast ? '' : '\n'));
    };
  }
  if (isDelete) {
    const p = oldPath!;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const isMove = oldPath !== newPath;
  if (isMove) {
    const oldP = oldPath!;
    const newP = newPath!;
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      let state = splitFile(cur);
      let d = 0;
      for (const h of s.hunks) {
        const { o, n } = bodyON(hunkBody(h.body).lines);
        state = applyHunk(state, h, strict, d, oldP);
        d += n.length - o.length;
      }
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(state));
      tree.moves.push({ old: oldP, neu: newP });
    };
  }
  const p = oldPath!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    let state = splitFile(cur);
    let d = 0;
    for (const h of s.hunks) {
      const { o, n } = bodyON(hunkBody(h.body).lines);
      state = applyHunk(state, h, strict, d, p);
      d += n.length - o.length;
    }
    tree.now.set(p, joinFile(state));
  };
}

function newUnifiedSection(gitOld: string | null, gitNew: string | null): UnifiedSection {
  return {
    gitOld,
    gitNew,
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    pairSeen: false,
    hadHunk: false,
    hunks: [],
  };
}

/** Unified diffs (SPEC.md section 6). A section is one edit. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let current: UnifiedSection | null = null;
  const finish = (): void => {
    if (current !== null) {
      edits.push(sectionToEdit(current, strict));
      current = null;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ') || line === 'diff --git') {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finish();
      current = newUnifiedSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (current !== null && !current.hadHunk && !current.pairSeen) {
        current.pairOld = unifiedPath(line);
        current.pairNew = unifiedPath(lines[i + 1]!);
        current.pairSeen = true;
        i += 2;
        continue;
      }
      finish();
      current = newUnifiedSection(null, null);
      current.pairOld = unifiedPath(line);
      current.pairNew = unifiedPath(lines[i + 1]!);
      current.pairSeen = true;
      i += 2;
      continue;
    }
    if (current === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (!current.hadHunk) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        current.pairNew = unifiedPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        current.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        current.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        current.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        current.deletedFile = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        const h = parseHunkHeader(line, i);
        current.hadHunk = true;
        current.hunks.push(h);
        i = collectHunkBody(lines, i + 1, h);
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const h = parseHunkHeader(line, i);
      current.hunks.push(h);
      i = collectHunkBody(lines, i + 1, h);
      continue;
    }
    i++;
  }
  finish();
  return edits;
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). Each block is one edit. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  for (;;) {
    let s = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, sep);
    const newLines = lines.slice(sep + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const f = splitFile(cur);
      const m = matchTier(f.lines, oldLines, strict);
      if (m === null) throw new Fail('no-match', p);
      if (m.occ.length !== 1) throw new Fail('ambiguous', p);
      const at = m.occ[0]!;
      const rendered = renderN(f.lines, at, oldLines, newLines, newLines.map(() => null), m.tier);
      const out = [...f.lines.slice(0, at), ...rendered, ...f.lines.slice(at + oldLines.length)];
      tree.now.set(p, joinFile({ lines: out, br: f.br, final: f.final }));
    });
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** A V4A chunk: its anchor (null: none), whether `*** End of File` anchors it to the file's end, its body lines. */
interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aBodyLine(l: string): BodyLine {
  if (l.startsWith(' ')) return { kind: 'ctx', text: l.slice(1) };
  if (l.startsWith('-')) return { kind: 'old', text: l.slice(1) };
  if (l.startsWith('+')) return { kind: 'new', text: l.slice(1) };
  return { kind: 'ctx', text: '' };
}

function v4aAddEdit(path: string, raw: string[], startIdx: number): Edit {
  const fileLines: string[] = [];
  for (let k = 0; k < raw.length; k++) {
    const l = raw[k]!;
    if (l.startsWith('+')) fileLines.push(l.slice(1));
    else if (l === '') fileLines.push('');
    else throw new Exit2(`error: parse ${startIdx + 2 + k}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string, raw: string[], startIdx: number): Edit {
  if (raw.length > 0) throw new Exit2(`error: parse ${startIdx + 2}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, raw: string[], startIdx: number, strict: boolean): Edit {
  let k = 0;
  let moveTo: string | null = null;
  if (k < raw.length && raw[k]!.startsWith('*** Move to:')) {
    moveTo = raw[k]!.slice('*** Move to:'.length).trim();
    k++;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let haveChunk = false;
  while (k < raw.length) {
    const l = raw[k]!;
    const lineNo = startIdx + 2 + k;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
      haveChunk = true;
      k++;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      cur = null;
      k++;
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null) {
        if (!haveChunk) {
          cur = { anchor: null, eof: false, body: [] };
          chunks.push(cur);
          haveChunk = true;
        } else throw new Exit2(`error: parse ${lineNo}`);
      }
      cur.body.push(v4aBodyLine(l));
      k++;
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  if (!haveChunk && moveTo === null) throw new Exit2(`error: parse ${startIdx + 1}`);
  const dest = moveTo;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (dest !== null && !safe(dest)) throw new Fail('unsafe', dest);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (dest !== null && tree.get(dest) !== null) throw new Fail('exists', dest);
    let state = splitFile(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const t of strict ? [0] : [0, 1, 2]) {
          found = findOccurrences(state.lines, [ch.anchor], t, cursor)[0] ?? -1;
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const { o, n, nCtx } = bodyON(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? state.lines.length : cursor;
        const out = [...state.lines.slice(0, at), ...n, ...state.lines.slice(at)];
        state = { lines: out, br: state.br, final: state.final };
        cursor = at + n.length;
      } else {
        let tier = -1;
        let occ: number[] = [];
        for (const t of strict ? [0] : [0, 1, 2]) {
          occ = findOccurrences(state.lines, o, t, cursor);
          if (ch.eof) occ = occ.filter((p) => p + o.length === state.lines.length);
          if (occ.length > 0) {
            tier = t;
            break;
          }
        }
        if (tier < 0) throw new Fail('no-match', path);
        const at = occ[0]!;
        const rendered = renderN(state.lines, at, o, n, nCtx, tier);
        const out = [...state.lines.slice(0, at), ...rendered, ...state.lines.slice(at + o.length)];
        state = { lines: out, br: state.br, final: state.final };
        cursor = at + rendered.length;
      }
    }
    const text = joinFile(state);
    if (dest !== null) {
      tree.now.set(path, null);
      tree.now.set(dest, text);
      tree.moves.push({ old: path, neu: dest });
    } else {
      tree.now.set(path, text);
    }
  };
}

/** V4A patches (SPEC.md section 8). Each section is one edit. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (!isSectionStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) j++;
    let end = j;
    while (end > i + 1 && blank(lines[end - 1]!)) end--;
    const raw = lines.slice(i + 1, end);
    if (line.startsWith('*** Add File:')) edits.push(v4aAddEdit(line.slice('*** Add File:'.length).trim(), raw, i));
    else if (line.startsWith('*** Delete File:')) edits.push(v4aDeleteEdit(line.slice('*** Delete File:'.length).trim(), raw, i));
    else edits.push(v4aUpdateEdit(line.slice('*** Update File:'.length).trim(), raw, i, strict));
    i = j;
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
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
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.neu);
    const nowNew = tree.get(m.neu);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.neu, line: `R ${m.old} -> ${m.neu}` });
      consumed.add(m.old);
      consumed.add(m.neu);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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

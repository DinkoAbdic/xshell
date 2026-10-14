import { invoke } from "@tauri-apps/api/core";
import type { Terminal, IDisposable, ILink } from "@xterm/xterm";

// Ctrl+click links for file paths printed in a terminal (agent output like `src/App.tsx:42`,
// or an installer path). Candidates are found with regexes, then checked against the disk in
// one batch; only paths that exist become links.

export interface PathTarget { path: string; isDir: boolean; line?: number; col?: number }

interface Resolved { path: string; is_dir: boolean }

// Windows absolute paths may contain spaces ("E:\My Apps\x.exe"), so they match greedily up to
// a quote/colon/end of line and are then tried at every space boundary, longest first.
const ABS_RE = /(?<![\w])[A-Za-z]:[\\/][^"'`<>|*?:\r\n]*/g;
// Relative with a folder (src/a.ts, ./a, ..\b\c.rs) or a bare file name with an extension (App.tsx).
const REL_RE = /(?:\.{1,2}[\\/])?(?:[\w@.+-]+[\\/])+[\w@.+-]+|[\w@+-][\w@.+-]*\.[A-Za-z]\w{0,9}/g;
// :line[:col] or (line[,col]) right after the path.
const SUFFIX_RE = /^(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))/;

// Text files open in the code editor; anything else (installers, archives, images, folders)
// is revealed in the OS file manager instead.
const TEXT_EXTS = new Set(("ts tsx mts cts js jsx mjs cjs json jsonc json5 css scss less html htm vue svelte astro xml svg xaml csproj plist rs py pyw md mdx markdown yml yaml sql java c h cpp cc cxx hpp hh php go toml sh bash zsh ps1 psm1 lua rb swift cs kt kts dart ini cfg conf properties env diff patch txt log csv tsv lock gitignore gitattributes editorconfig npmrc prettierrc eslintrc babelrc dockerignore graphql gql proto bat cmd").split(" "));

export function isTextFile(path: string): boolean {
  const name = path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1).toLowerCase();
  if (name === "dockerfile" || name === "makefile" || name.startsWith(".env")) return true;
  const dot = name.lastIndexOf(".");
  return dot >= 0 && TEXT_EXTS.has(name.slice(dot + 1));
}

// Strip punctuation that commonly trails a path in prose ("see src/a.ts.").
function trimTrailing(s: string): string { return s.replace(/[.,;:!?'"`)\]}>]+$/, ""); }

// Candidate spots in one line of text; each has its candidate strings, longest first.
function findCandidates(text: string): { start: number; options: string[] }[] {
  const groups: { start: number; options: string[] }[] = [];
  const covered: [number, number][] = [];
  let m: RegExpExecArray | null;
  ABS_RE.lastIndex = 0;
  while ((m = ABS_RE.exec(text))) {
    const full = trimTrailing(m[0].trimEnd());
    const options = [full];
    for (let i = full.length - 1; i > 2; i--) if (full[i] === " ") options.push(trimTrailing(full.slice(0, i)));
    groups.push({ start: m.index, options: [...new Set(options)].filter((o) => o.length > 3) });
    covered.push([m.index, m.index + m[0].length]);
  }
  REL_RE.lastIndex = 0;
  while ((m = REL_RE.exec(text))) {
    const at = m.index;
    if (covered.some(([a, b]) => at >= a && at < b)) continue;
    // Skip the path part of URLs (handled by the web-links addon).
    if (/[a-z]+:\/\/\S*$/i.test(text.slice(0, at + 1))) continue;
    const raw = trimTrailing(m[0]);
    if (raw.length < 3 || /^\d+(\.\d+)*$/.test(raw)) continue;
    groups.push({ start: at, options: [raw] });
  }
  return groups;
}

export function registerPathLinks(term: Terminal, getCwd: () => string | undefined, onOpen: (t: PathTarget) => void): IDisposable {
  // cwd|candidate → resolved (or null when it doesn't exist); entries expire so files created
  // later become links too.
  const cache = new Map<string, { at: number; value: Resolved | null }>();
  const TTL = 10_000;

  return term.registerLinkProvider({
    provideLinks(y, callback) {
      const cwd = getCwd();
      const bufLine = term.buffer.active.getLine(y - 1);
      if (!cwd || !bufLine) { callback(undefined); return; }
      const text = bufLine.translateToString(true);
      const found = findCandidates(text);
      if (found.length === 0) { callback(undefined); return; }

      const key = (o: string) => cwd + "|" + o;
      const now = Date.now();
      const missing = [...new Set(found.flatMap((f) => f.options))].filter((o) => {
        const c = cache.get(key(o));
        return !c || now - c.at > TTL;
      });
      const build = () => {
        const links: ILink[] = [];
        for (const f of found) {
          const raw = f.options.find((o) => cache.get(key(o))?.value);
          const r = raw ? cache.get(key(raw))?.value : null;
          if (!raw || !r) continue;
          const sm = SUFFIX_RE.exec(text.slice(f.start + raw.length));
          const lineNo = sm ? sm[1] ?? sm[3] : undefined;
          const colNo = sm ? sm[2] ?? sm[4] : undefined;
          const len = raw.length + (sm ? sm[0].length : 0);
          const target: PathTarget = { path: r.path, isDir: r.is_dir, line: lineNo ? +lineNo : undefined, col: colNo ? +colNo : undefined };
          links.push({
            range: { start: { x: f.start + 1, y }, end: { x: f.start + len, y } },
            text: text.slice(f.start, f.start + len),
            decorations: { pointerCursor: true, underline: true },
            activate: (ev: MouseEvent) => { if (ev.ctrlKey || ev.metaKey) { ev.preventDefault(); onOpen(target); } },
          });
        }
        callback(links.length ? links : undefined);
      };
      if (missing.length === 0) { build(); return; }
      invoke<(Resolved | null)[]>("resolve_paths", { cwd, paths: missing })
        .then((res) => { res.forEach((r, i) => cache.set(key(missing[i]), { at: now, value: r })); build(); })
        .catch(() => callback(undefined));
    },
  });
}

// Default Ctrl+click behavior: text files open in the editor, everything else (installers,
// archives, images) reveals in the OS file manager with the file selected; folders open.
export function openPathTarget(t: PathTarget, openInEditor: (path: string, line?: number, col?: number) => void) {
  if (!t.isDir && isTextFile(t.path)) openInEditor(t.path, t.line, t.col);
  else invoke("reveal_in_explorer", { path: t.path }).catch(() => {});
}

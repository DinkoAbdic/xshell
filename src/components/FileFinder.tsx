import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Search, CaseSensitive } from "lucide-react";
import { fileIconUrl } from "../lib/fileIcons";

// Quick Open (Ctrl+P) and Search in project (Ctrl+Shift+F). Both list the project's files
// through the backend's .gitignore-aware walker and open the pick in the code editor.

interface Props {
  root: string;
  onOpen: (path: string, line?: number, col?: number) => void;
  onClose: () => void;
}

function joinPath(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + sep + rel.replace(/\//g, sep);
}
function baseName(p: string): string { return p.slice(p.lastIndexOf("/") + 1); }
function dirName(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }

// Shared keyboard handling: arrows move the highlight, Enter picks, Esc closes.
function useListKeys(count: number, onPick: (i: number) => void, onClose: () => void) {
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setIdx(0); }, [count]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(count - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter" && count > 0) { e.preventDefault(); onPick(idx); }
  };
  return { idx, setIdx, listRef, onKeyDown };
}

// Fuzzy score for a relative path; null = no match. Matches in the file name rank first.
function score(path: string, q: string): number | null {
  const p = path.toLowerCase();
  const name = baseName(p);
  if (name.startsWith(q)) return 3000 - name.length;
  if (name.includes(q)) return 2000 - name.length;
  if (p.includes(q)) return 1000 - p.length;
  let gaps = 0, from = 0;
  for (const ch of q) {
    const at = p.indexOf(ch, from);
    if (at < 0) return null;
    gaps += at - from;
    from = at + 1;
  }
  return 500 - gaps - p.length / 10;
}

export function QuickOpenDialog({ root, onOpen, onClose }: Props) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => { invoke<string[]>("list_project_files", { root }).then(setFiles).catch(() => setFiles([])); }, [root]);

  const results = useMemo(() => {
    if (!files) return [];
    const q = query.trim().toLowerCase().replace(/\s+/g, "").replace(/\\/g, "/");
    if (!q) return files.slice(0, 100);
    const scored: { path: string; s: number }[] = [];
    for (const f of files) { const s = score(f, q); if (s !== null) scored.push({ path: f, s }); }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, 100).map((x) => x.path);
  }, [files, query]);

  const pick = (i: number) => { const rel = results[i]; if (rel) { onOpen(joinPath(root, rel)); onClose(); } };
  const { idx, setIdx, listRef, onKeyDown } = useListKeys(results.length, pick, onClose);

  return (
    <div className="ts-overlay" onMouseDown={onClose}>
      <div className="ts-dialog finder-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ts-search-row">
          <Search size={14} className="ts-search-icon" />
          <input autoFocus className="ts-search-input" placeholder="Go to file…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} spellCheck={false} />
          {files && <span className="ts-count">{files.length}</span>}
        </div>
        <div className="ts-list" ref={listRef}>
          {files === null && <div className="ts-empty">Indexing files…</div>}
          {files !== null && results.length === 0 && <div className="ts-empty">No matching files</div>}
          {results.map((rel, i) => (
            <div key={rel} data-idx={i} className={`ts-row finder-row ${i === idx ? "highlighted" : ""}`} onMouseEnter={() => setIdx(i)} onClick={() => pick(i)}>
              <img className="finder-icon" src={fileIconUrl(baseName(rel))} alt="" />
              <span className="finder-name">{baseName(rel)}</span>
              <span className="finder-dir">{dirName(rel)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface Hit { path: string; line: number; col: number; text: string }
const SEARCH_LIMIT = 500;

export function ProjectSearchDialog({ root, onOpen, onClose, initialQuery }: Props & { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = query;
    if (q.trim().length < 2) { setHits(null); setSearching(false); return; }
    setSearching(true);
    let alive = true;
    const t = window.setTimeout(() => {
      invoke<Hit[]>("search_project", { root, query: q, caseSensitive, limit: SEARCH_LIMIT })
        .then((h) => { if (alive) setHits(h); })
        .catch(() => { if (alive) setHits([]); })
        .finally(() => { if (alive) setSearching(false); });
    }, 250);
    return () => { alive = false; window.clearTimeout(t); };
  }, [query, caseSensitive, root]);

  const list = hits ?? [];
  const pick = (i: number) => { const h = list[i]; if (h) { onOpen(joinPath(root, h.path), h.line, h.col); onClose(); } };
  const { idx, setIdx, listRef, onKeyDown } = useListKeys(list.length, pick, onClose);
  const fileCount = useMemo(() => new Set(list.map((h) => h.path)).size, [list]);

  // Show the match in the line, trimming long leading text so the hit stays visible.
  const renderLine = (h: Hit) => {
    const chars = [...h.text];
    const start = h.col - 1;
    const end = start + [...query].length;
    const lead = Math.max(0, start - 30);
    const pre = (lead > 0 ? "…" : "") + chars.slice(lead, start).join("").trimStart();
    return <>{pre}<mark className="finder-mark">{chars.slice(start, end).join("")}</mark>{chars.slice(end).join("")}</>;
  };

  return (
    <div className="ts-overlay" onMouseDown={onClose}>
      <div className="ts-dialog finder-dialog finder-search" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ts-search-row">
          <Search size={14} className="ts-search-icon" />
          <input autoFocus className="ts-search-input" placeholder="Search in project…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} spellCheck={false} />
          {searching && <span className="file-search-spinner" />}
          <button className={`finder-case ${caseSensitive ? "active" : ""}`} onClick={() => setCaseSensitive((v) => !v)} title="Match case"><CaseSensitive size={15} /></button>
        </div>
        {hits && hits.length > 0 && (
          <div className="finder-summary">{hits.length >= SEARCH_LIMIT ? `${SEARCH_LIMIT}+` : hits.length} results in {fileCount} files</div>
        )}
        <div className="ts-list" ref={listRef}>
          {hits === null && !searching && <div className="ts-empty">Type at least 2 characters</div>}
          {hits !== null && hits.length === 0 && !searching && <div className="ts-empty">No results</div>}
          {list.map((h, i) => (
            <div key={`${h.path}:${h.line}:${i}`}>
              {(i === 0 || list[i - 1].path !== h.path) && (
                <div className="finder-file">
                  <img className="finder-icon" src={fileIconUrl(baseName(h.path))} alt="" />
                  <span className="finder-name">{baseName(h.path)}</span>
                  <span className="finder-dir">{dirName(h.path)}</span>
                </div>
              )}
              <div data-idx={i} className={`ts-row finder-hit ${i === idx ? "highlighted" : ""}`} onMouseEnter={() => setIdx(i)} onClick={() => pick(i)}>
                <span className="finder-lineno">{h.line}</span>
                <span className="finder-text">{renderLine(h)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

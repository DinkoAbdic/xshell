import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X as XIcon, AlertTriangle, AtSign } from "lucide-react";
import { EditorState, type Extension, type Text } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle, bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import { fileIconUrl } from "../../lib/fileIcons";
import { languageFor } from "./languages";
import { gitGutter, setGitBase } from "./gitGutter";
import { confirmDialog } from "../ConfirmDialog";

interface CodeFile { content: string | null; mtime_ms: number; size: number; binary: boolean; too_large: boolean }

// Per-file editor state. One EditorView is shared by all open files; switching tabs swaps the
// EditorState in, so each file keeps its own undo history, selection and scroll position.
interface Entry {
  status: "loading" | "ready" | "binary" | "large" | "error";
  error?: string;
  state?: EditorState;
  savedDoc?: Text;   // doc as last read from / written to disk; dirty = current doc differs
  mtime: number;     // disk mtime we last synced with
  scrollTop: number;
  language: string;
}

type Conflict = "changed" | "deleted";

const POLL_MS = 1500;

// Token colors come from CSS classes (.cm-tok-*) so App.css can theme them for dark and light.
const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier, t.self], class: "cm-tok-keyword" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.escape], class: "cm-tok-string" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], class: "cm-tok-number" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "cm-tok-comment" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], class: "cm-tok-function" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName), t.standard(t.typeName)], class: "cm-tok-type" },
  { tag: [t.propertyName, t.attributeName, t.labelName], class: "cm-tok-property" },
  { tag: [t.tagName, t.angleBracket], class: "cm-tok-tag" },
  { tag: [t.meta, t.processingInstruction, t.annotation, t.macroName], class: "cm-tok-meta" },
  { tag: [t.heading], class: "cm-tok-heading" },
  { tag: [t.link, t.url], class: "cm-tok-link" },
  { tag: t.emphasis, class: "cm-tok-em" },
  { tag: t.strong, class: "cm-tok-strong" },
  { tag: [t.inserted], class: "cm-tok-string" },
  { tag: [t.deleted, t.invalid], class: "cm-tok-invalid" },
]);

const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--bg-surface)", color: "var(--text-primary)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--accent-terracotta)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent-terracotta)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgba(201, 100, 66, 0.28) !important" },
  ".cm-gutters": { backgroundColor: "var(--bg-surface)", color: "var(--text-muted)", border: "none" },
  ".cm-activeLine": { backgroundColor: "var(--bg-elevated)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--bg-elevated)", color: "var(--text-secondary)" },
  ".cm-selectionMatch": { backgroundColor: "var(--bg-active)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--bg-active)", outline: "1px solid var(--border-strong)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-card)", border: "1px solid var(--border-default)", color: "var(--text-secondary)" },
  ".cm-panels": { backgroundColor: "var(--bg-elevated)", color: "var(--text-primary)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border-default)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border-default)" },
  ".cm-searchMatch": { backgroundColor: "rgba(201, 100, 66, 0.25)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(201, 100, 66, 0.5)" },
  ".cm-textfield": { backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-default)", color: "var(--text-primary)", borderRadius: "4px" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--bg-card)", border: "1px solid var(--border-default)", color: "var(--text-primary)", borderRadius: "4px" },
});

function baseName(p: string): string { return p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1); }

function relPath(path: string, root: string): string {
  const r = root.replace(/[\\/]+$/, "");
  return path.toLowerCase().startsWith(r.toLowerCase() + "\\") || path.toLowerCase().startsWith(r.toLowerCase() + "/") ? path.slice(r.length + 1) : path;
}

interface Props {
  files: string[];
  active: string | null;
  rootPath: string;
  visible: boolean;
  gotoTarget?: { path: string; line: number; col?: number; seq: number } | null;
  onSendToAgent?: (path: string, fromLine: number | null, toLine: number | null) => void;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}

export default function CodeEditorPane({ files, active, rootPath, visible, gotoTarget, onSendToAgent, onActivate, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const entries = useRef(new Map<string, Entry>());
  const shownPath = useRef<string | null>(null); // path whose state is currently in the view
  const [renderTick, setRender] = useState(0);
  const rerender = useCallback(() => setRender((n) => n + 1), []);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [conflicts, setConflicts] = useState<Record<string, Conflict>>({});

  const save = useCallback(async (path: string) => {
    const e = entries.current.get(path);
    const view = viewRef.current;
    if (!e?.state || !view) return;
    const doc = shownPath.current === path ? view.state.doc : e.state.doc;
    try {
      e.mtime = await invoke<number>("write_code_file", { path, content: doc.toString() });
      e.savedDoc = doc;
      refreshGitBaseRef.current(path);
      setDirty((d) => ({ ...d, [path]: false }));
      setConflicts((c) => { const n = { ...c }; delete n[path]; return n; });
    } catch (err) {
      e.error = String(err);
      rerender();
    }
  }, [rerender]);
  const saveRef = useRef(save);
  saveRef.current = save;

  // Reference the selection (or the whole file when nothing is selected) in the agent's prompt.
  const sendToAgent = useCallback(() => {
    const view = viewRef.current;
    const path = shownPath.current;
    if (!view || !path || !onSendToAgent) return;
    const sel = view.state.selection.main;
    if (sel.empty) { onSendToAgent(path, null, null); return; }
    const doc = view.state.doc;
    const from = doc.lineAt(sel.from).number;
    let to = doc.lineAt(sel.to).number;
    if (to > from && doc.lineAt(sel.to).from === sel.to) to--; // selection ends at the start of a line
    onSendToAgent(path, from, to);
  }, [onSendToAgent]);
  const sendRef = useRef(sendToAgent);
  sendRef.current = sendToAgent;

  const makeState = useCallback((path: string, doc: string, lang: Extension | null) => {
    const exts: Extension[] = [
      gitGutter(), lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(),
      drawSelection(), EditorState.allowMultipleSelections.of(true), indentOnInput(),
      syntaxHighlighting(highlightStyle), bracketMatching(), closeBrackets(),
      rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => { saveRef.current(path); return true; } },
        { key: "Mod-l", preventDefault: true, run: () => { sendRef.current(); return true; } },
        ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab,
      ]),
      editorTheme,
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        const e = entries.current.get(path);
        if (!e?.savedDoc) return;
        const isDirty = !u.state.doc.eq(e.savedDoc);
        setDirty((d) => (d[path] === isDirty ? d : { ...d, [path]: isDirty }));
      }),
    ];
    if (lang) exts.push(lang);
    return EditorState.create({ doc, extensions: exts });
  }, []);

  // Create the shared view once.
  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({ parent: hostRef.current, state: EditorState.create({ doc: "" }) });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  }, []);

  // Stash the outgoing file's state + scroll, then show the active one (loading it on first open).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const prev = shownPath.current;
    if (prev && prev !== active) {
      const e = entries.current.get(prev);
      if (e && e.status === "ready") { e.state = view.state; e.scrollTop = view.scrollDOM.scrollTop; }
    }
    if (!active) { shownPath.current = null; return; }
    if (prev === active) return;
    shownPath.current = active;
    const e = entries.current.get(active);
    if (e) {
      if (e.status === "ready" && e.state) {
        view.setState(e.state);
        const top = e.scrollTop;
        const gotoSeq = appliedGoto.current;
        // Restore the file's scroll position, unless a go-to-line just moved it.
        requestAnimationFrame(() => { if (appliedGoto.current === gotoSeq) view.scrollDOM.scrollTop = top; });
        view.focus();
      }
      return;
    }
    const path = active;
    const lang = languageFor(path);
    const entry: Entry = { status: "loading", mtime: 0, scrollTop: 0, language: lang?.label ?? "Plain text" };
    entries.current.set(path, entry);
    rerender();
    Promise.all([invoke<CodeFile>("read_code_file", { path }), lang ? lang.load().catch(() => null) : Promise.resolve(null)])
      .then(([file, langExt]) => {
        entry.mtime = file.mtime_ms;
        if (file.too_large) { entry.status = "large"; return; }
        if (file.binary || file.content === null) { entry.status = "binary"; return; }
        entry.state = makeState(path, file.content, langExt);
        entry.savedDoc = entry.state.doc;
        entry.status = "ready";
        if (shownPath.current === path && viewRef.current) { viewRef.current.setState(entry.state); viewRef.current.focus(); }
        refreshGitBaseRef.current(path);
      })
      .catch((err) => { entry.status = "error"; entry.error = String(err); })
      .finally(rerender);
  }, [active, makeState, rerender]);

  // Jump to a line requested from outside (Ctrl+click on `path:line`), once the file is shown.
  const appliedGoto = useRef(0);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !gotoTarget || gotoTarget.seq === appliedGoto.current) return;
    if (gotoTarget.path !== active || shownPath.current !== active || entries.current.get(active)?.status !== "ready") return;
    appliedGoto.current = gotoTarget.seq;
    const doc = view.state.doc;
    const line = doc.line(Math.max(1, Math.min(doc.lines, gotoTarget.line)));
    const pos = Math.min(line.to, line.from + Math.max(0, (gotoTarget.col ?? 1) - 1));
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    view.focus();
  }, [gotoTarget, active, renderTick]);

  // Forget closed files so reopening one re-reads it from disk.
  useEffect(() => {
    for (const p of [...entries.current.keys()]) if (!files.includes(p)) entries.current.delete(p);
    setDirty((d) => Object.fromEntries(Object.entries(d).filter(([p]) => files.includes(p))));
    setConflicts((c) => Object.fromEntries(Object.entries(c).filter(([p]) => files.includes(p))));
  }, [files]);

  // Load the HEAD version of a file into its change-marker gutter (null = untracked / no repo).
  const refreshGitBase = useCallback((path: string) => {
    invoke<string | null>("git_head_content", { path }).then((base) => {
      const e = entries.current.get(path);
      if (!e || e.status !== "ready" || !e.state) return;
      const effects = setGitBase.of(base);
      if (shownPath.current === path && viewRef.current) viewRef.current.dispatch({ effects });
      else e.state = e.state.update({ effects }).state;
    }).catch(() => {});
  }, []);
  const refreshGitBaseRef = useRef(refreshGitBase);
  refreshGitBaseRef.current = refreshGitBase;

  const reloadFromDisk = useCallback(async (path: string) => {
    const e = entries.current.get(path);
    const view = viewRef.current;
    if (!e || e.status !== "ready" || !view) return;
    const file = await invoke<CodeFile>("read_code_file", { path });
    if (file.content === null) return;
    const current = shownPath.current === path ? view.state : e.state!;
    const tr = current.update({ changes: { from: 0, to: current.doc.length, insert: file.content } });
    if (shownPath.current === path) { view.dispatch(tr); e.savedDoc = view.state.doc; }
    else { e.state = tr.state; e.savedDoc = tr.state.doc; }
    e.mtime = file.mtime_ms;
    setDirty((d) => ({ ...d, [path]: false }));
    setConflicts((c) => { const n = { ...c }; delete n[path]; return n; });
  }, []);

  // Watch the active file on disk (agents edit files constantly). Unmodified → reload silently;
  // modified in the editor → show a conflict bar instead of clobbering the user's edits.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!visible || !active) return;
    const path = active;
    let ticks = 0;
    const check = () => {
      const e = entries.current.get(path);
      if (!e || e.status !== "ready") return;
      // HEAD moves when the agent commits; re-read it now and then (and when the file is shown).
      if (ticks++ % 8 === 0) refreshGitBase(path);
      invoke<number | null>("code_file_mtime", { path }).then((m) => {
        if (m === null) { setConflicts((c) => (c[path] === "deleted" ? c : { ...c, [path]: "deleted" })); return; }
        if (m === e.mtime) return;
        if (dirtyRef.current[path]) setConflicts((c) => (c[path] === "changed" ? c : { ...c, [path]: "changed" }));
        else reloadFromDisk(path).catch(() => {});
      }).catch(() => {});
    };
    check();
    const id = window.setInterval(check, POLL_MS);
    return () => window.clearInterval(id);
  }, [visible, active, reloadFromDisk, refreshGitBase]);

  const keepMine = useCallback((path: string) => {
    // Accept the disk version as the new baseline for conflict checks; the next save overwrites it.
    invoke<number | null>("code_file_mtime", { path }).then((m) => {
      const e = entries.current.get(path);
      if (e && m !== null) e.mtime = m;
    }).catch(() => {});
    setConflicts((c) => { const n = { ...c }; delete n[path]; return n; });
  }, []);

  const requestClose = useCallback(async (path: string) => {
    if (dirty[path]) {
      const discard = await confirmDialog({ title: "Unsaved changes", message: `${baseName(path)} has unsaved changes. Close it and discard them?`, confirmLabel: "Discard", danger: true });
      if (!discard) return;
    }
    onClose(path);
  }, [dirty, onClose]);

  const entry = active ? entries.current.get(active) : undefined;
  const conflict = active ? conflicts[active] : undefined;

  return (
    <div className="code-editor-pane">
      <div className="code-editor-tabs">
        {files.map((p) => (
          <div
            key={p}
            className={`code-editor-tab ${p === active ? "active" : ""}`}
            title={p}
            onClick={() => onActivate(p)}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); requestClose(p); } }}
          >
            <img className="code-editor-tab-icon" src={fileIconUrl(baseName(p))} alt="" draggable={false} />
            <span className="code-editor-tab-name">{baseName(p)}</span>
            <button className={`code-editor-tab-close ${dirty[p] ? "dirty" : ""}`} onClick={(e) => { e.stopPropagation(); requestClose(p); }} aria-label="Close">
              <span className="code-editor-dirty-dot" />
              <XIcon size={12} />
            </button>
          </div>
        ))}
      </div>
      {active && (
        <div className="code-editor-pathbar">
          <span className="code-editor-path">{relPath(active, rootPath)}</span>
          {entry && <span className="code-editor-lang">{entry.language}</span>}
          {onSendToAgent && entry?.status === "ready" && (
            <button className="code-editor-send" onClick={sendToAgent} title="Reference the selected lines (or the whole file) in the agent's prompt (Ctrl+L)">
              <AtSign size={11} /> Send to agent
            </button>
          )}
        </div>
      )}
      {conflict && active && (
        <div className="code-editor-conflict">
          <AlertTriangle size={13} />
          <span>{conflict === "deleted" ? "This file was deleted on disk." : "This file changed on disk and you have unsaved edits."}</span>
          {conflict === "changed" && <button onClick={() => reloadFromDisk(active).catch(() => {})}>Reload</button>}
          {conflict === "changed" && <button onClick={() => keepMine(active)}>Keep mine</button>}
          {conflict === "deleted" && <button onClick={() => save(active)}>Save again</button>}
          {conflict === "deleted" && <button onClick={() => requestClose(active)}>Close</button>}
        </div>
      )}
      <div className="code-editor-body">
        <div ref={hostRef} className="code-editor-host" style={{ visibility: entry?.status === "ready" ? "visible" : "hidden" }} />
        {entry && entry.status !== "ready" && (
          <div className="code-editor-message">
            {entry.status === "loading" && "Loading…"}
            {entry.status === "binary" && "Binary file - can't be shown as text."}
            {entry.status === "large" && "File is larger than 5 MB - not opened in the editor."}
            {entry.status === "error" && (entry.error || "Couldn't open the file.")}
          </div>
        )}
        {entry?.status === "ready" && entry.error && (
          <div className="code-editor-error" onClick={() => { entry.error = undefined; rerender(); }}>{entry.error}</div>
        )}
      </div>
    </div>
  );
}

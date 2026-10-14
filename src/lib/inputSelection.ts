import type { Terminal, IDisposable } from "@xterm/xterm";

// EXPERIMENTAL — emulated text selection in an agent's prompt input (Ctrl+A, Shift/Ctrl+Shift
// + arrows, then copy / cut / delete / type-over). The input box belongs to the agent's TUI, not
// to xterm, so XShell drives the agent's own cursor keys and mirrors the caret movement as an
// xterm selection. Self-contained: TerminalTab calls `handleKey` first in its key handler and
// can drop this module (or turn it off in Settings) without touching anything else.

// Keys understood by readline-style inputs (Claude Code, Codex…).
const KEY = {
  left: "\x1b[D", right: "\x1b[C",
  wordLeft: "\x1bb", wordRight: "\x1bf",   // Alt+B / Alt+F
  lineStart: "\x01", lineEnd: "\x05",      // Ctrl+A / Ctrl+E
  backspace: "\x7f",
};

const REDRAW_TIMEOUT_MS = 250;
const SCAN_ROWS = 30;

interface Pos { col: number; row: number } // row = absolute buffer row

export interface InputSelection extends IDisposable {
  // Returns false when the key was consumed (xterm must not process it), true otherwise.
  handleKey(ev: KeyboardEvent): boolean;
}

export function attachInputSelection(term: Terminal, send: (data: string) => void): InputSelection {
  let anchor: Pos | null = null;  // where the selection started; null = no emulated selection
  let caret: Pos | null = null;   // where the agent's caret is now
  let busy = false;               // a key sequence is still waiting for the agent to redraw

  // The agent's caret: TUIs like Claude Code hide the hardware cursor and draw the caret as a
  // single inverse-video cell, so look for an isolated inverse cell near the bottom of the
  // screen. Falls back to xterm's own cursor.
  const findCaret = (): Pos => {
    const buf = term.buffer.active;
    const bottom = buf.viewportY + term.rows - 1;
    const cell = buf.getNullCell();
    for (let row = bottom; row >= Math.max(buf.viewportY, bottom - SCAN_ROWS); row--) {
      const line = buf.getLine(row);
      if (!line) continue;
      for (let col = term.cols - 1; col >= 0; col--) {
        if (!line.getCell(col, cell)?.isInverse()) continue;
        const prev = col > 0 && line.getCell(col - 1, cell)?.isInverse();
        const next = col < term.cols - 1 && line.getCell(col + 1, cell)?.isInverse();
        if (!prev && !next) return { col, row };
      }
    }
    return { col: buf.cursorX, row: buf.baseY + buf.cursorY };
  };

  // Resolve after the agent has redrawn in response to what we sent (or after a timeout).
  const waitRedraw = () => new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; sub.dispose(); window.clearTimeout(t); setTimeout(resolve, 16); };
    const sub = term.onWriteParsed(finish);
    const t = window.setTimeout(finish, REDRAW_TIMEOUT_MS);
  });

  const linear = (p: Pos) => p.row * term.cols + p.col;

  const paint = () => {
    if (!anchor || !caret) return;
    const a = linear(anchor), c = linear(caret);
    if (a === c) { term.clearSelection(); return; }
    const start = Math.min(a, c);
    term.select(start % term.cols, Math.floor(start / term.cols), Math.abs(a - c));
  };

  const clear = () => { anchor = null; caret = null; term.clearSelection(); };

  // Number of input characters in the selection. Rows after the first are the input's own
  // wrapped/continued lines; their leading indentation is the TUI's padding, not input text.
  const selectedLength = () => {
    const text = term.getSelection();
    return Array.from(text.replace(/\r?\n[ \t]*/g, "")).length;
  };

  const move = async (keys: string) => {
    busy = true;
    try {
      if (!anchor) { anchor = findCaret(); caret = anchor; }
      send(keys);
      await waitRedraw();
      caret = findCaret();
      paint();
    } finally { busy = false; }
  };

  const selectAll = async () => {
    busy = true;
    try {
      send(KEY.lineEnd);
      await waitRedraw();
      anchor = findCaret();
      send(KEY.lineStart);
      await waitRedraw();
      caret = findCaret();
      paint();
    } finally { busy = false; }
  };

  // Delete the selected text: move the caret to the selection's end, then backspace over it.
  const deleteSelection = () => {
    if (!anchor || !caret) return;
    const n = selectedLength();
    const caretFirst = linear(caret) < linear(anchor);
    clear();
    if (n === 0) return;
    send((caretFirst ? KEY.right.repeat(n) : "") + KEY.backspace.repeat(n));
  };

  const onMouseDown = () => { anchor = null; caret = null; };
  term.element?.addEventListener("mousedown", onMouseDown, true);

  return {
    handleKey(ev) {
      if (ev.type !== "keydown") return !busy;
      if (busy) { ev.preventDefault(); return false; }
      const k = ev.key;
      const ctrl = ev.ctrlKey || ev.metaKey;

      // Extend / start a selection.
      if (ev.shiftKey && !ev.altKey && (k === "ArrowLeft" || k === "ArrowRight" || k === "Home" || k === "End")) {
        ev.preventDefault();
        const keys = k === "Home" ? KEY.lineStart : k === "End" ? KEY.lineEnd
          : k === "ArrowLeft" ? (ctrl ? KEY.wordLeft : KEY.left) : (ctrl ? KEY.wordRight : KEY.right);
        move(keys);
        return false;
      }
      if (ctrl && !ev.shiftKey && !ev.altKey && k.toLowerCase() === "a") {
        ev.preventDefault();
        selectAll();
        return false;
      }
      if (!anchor) return true;

      // With an emulated selection active:
      if (ctrl && !ev.shiftKey && k.toLowerCase() === "c") return true; // TerminalTab copies the selection
      if (ctrl && !ev.shiftKey && k.toLowerCase() === "x") {
        ev.preventDefault();
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        deleteSelection();
        return false;
      }
      if (k === "Backspace" || k === "Delete") {
        ev.preventDefault();
        deleteSelection();
        return false;
      }
      if (k === "Shift" || k === "Control" || k === "Alt" || k === "Meta") return true;
      // Typing a character replaces the selection; the key itself then goes through as usual.
      if (k.length === 1 && !ctrl && !ev.altKey) { deleteSelection(); return true; }
      if (ctrl && !ev.shiftKey && k.toLowerCase() === "v") { deleteSelection(); return true; }
      // Anything else (plain arrows, Enter, Esc…) just drops the selection.
      clear();
      return true;
    },
    dispose() {
      term.element?.removeEventListener("mousedown", onMouseDown, true);
      clear();
    },
  };
}

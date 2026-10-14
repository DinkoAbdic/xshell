import { useEffect, useRef } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { detectMonoFontFamily, ensureMonoFontsLoaded } from "../lib/fonts";
import { registerPathLinks, type PathTarget } from "../lib/pathLinks";

interface Props {
  id: string;                 // PTY id; also XSHELL_TAB_ID, so dev servers started here map to the tab
  cwd: string;
  shellId: string | null;
  shellCommand: string | null;
  palette: ITheme;
  fontSize: number;
  fontWeight: number;
  scrollback: number;
  visible: boolean;           // focus + refit when shown
  onExit: () => void;
  onOpenPath: (t: PathTarget) => void;
}

// A plain shell for the bottom panel of an agent tab (dev servers, builds, git…). A slimmed-down
// version of TerminalTab's xterm setup: no agent, no session, same paste/copy/link behavior.
export function ShellTerminal({ id, cwd, shellId, shellCommand, palette, fontSize, fontWeight, scrollback, visible, onExit, onOpenPath }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onOpenPathRef = useRef(onOpenPath);
  onOpenPathRef.current = onOpenPath;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      theme: palette, fontFamily: detectMonoFontFamily(), fontSize, fontWeight,
      cursorBlink: false, cursorStyle: "bar", cursorInactiveStyle: "outline",
      scrollback, allowProposedApi: true, minimumContrastRatio: 1,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((ev, uri) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      invoke("open_url", { url: uri }).catch(() => {});
    }));
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    const pathLinks = registerPathLinks(term, () => cwdRef.current, (t) => onOpenPathRef.current(t));
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const paste = async () => {
      const text = await navigator.clipboard.readText().catch(() => "");
      if (text) term.paste(text);
    };
    // Ctrl+V pastes, Ctrl+C copies when there's a selection (otherwise it's ^C).
    term.attachCustomKeyEventHandler((ev) => {
      if (!ev.ctrlKey || ev.type !== "keydown" || ev.altKey) return true;
      const k = ev.key.toLowerCase();
      if (!ev.shiftKey && k === "v") { ev.preventDefault(); paste(); return false; }
      if (!ev.shiftKey && k === "c" && term.hasSelection()) {
        ev.preventDefault();
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      return true;
    });
    const onContextMenu = (ev: MouseEvent) => { ev.preventDefault(); paste(); };
    host.addEventListener("contextmenu", onContextMenu);

    // Spawn after fonts + a non-zero layout, and never for a torn-down mount (StrictMode).
    let disposed = false;
    let cleanupPty: (() => void) | null = null;
    ensureMonoFontsLoaded().then(() => {
      const start = () => {
        if (disposed) return;
        if (host.offsetWidth === 0 || host.offsetHeight === 0) { requestAnimationFrame(start); return; }
        fit.fit();
        const onData = new Channel<ArrayBuffer>();
        onData.onmessage = (buf) => term.write(new Uint8Array(buf));
        const onExitCh = new Channel<number>();
        onExitCh.onmessage = () => onExitRef.current();
        const dataSub = term.onData((data) => { invoke("write_terminal", { id, data }).catch(() => {}); });
        let resizeTimer: number | undefined;
        const resizeSub = term.onResize(({ cols, rows }) => {
          if (resizeTimer) window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(() => { invoke("resize_terminal", { id, cols, rows }).catch(() => {}); }, 100);
        });
        cleanupPty = () => {
          onData.onmessage = () => {};
          onExitCh.onmessage = () => {};
          if (resizeTimer) window.clearTimeout(resizeTimer);
          dataSub.dispose();
          resizeSub.dispose();
          invoke("close_terminal", { id }).catch(() => {});
        };
        invoke("spawn_terminal", { id, sessionId: null, cwd: cwdRef.current, cols: term.cols, rows: term.rows, shellMode: "raw", shellCommand, shellId, agent: null, fullscreenRendering: false, forceSyncOutput: false, onData, onExit: onExitCh })
          .then(() => term.focus())
          .catch((err) => term.write(`\x1b[31mFailed to start shell: ${err}\x1b[0m\r\n`));
      };
      start();
    });

    const ro = new ResizeObserver(() => requestAnimationFrame(() => { if (host.offsetWidth > 0 && host.offsetHeight > 0) fit.fit(); }));
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      host.removeEventListener("contextmenu", onContextMenu);
      cleanupPty?.();
      pathLinks.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // The PTY lives for the component's lifetime; option changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => { if (termRef.current) termRef.current.options.theme = palette; }, [palette]);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    term.options.fontWeight = fontWeight;
    requestAnimationFrame(() => fitRef.current?.fit());
  }, [fontSize, fontWeight]);
  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      const host = hostRef.current;
      if (host && host.offsetWidth > 0 && host.offsetHeight > 0) fitRef.current?.fit();
      termRef.current?.focus();
    });
  }, [visible]);

  return <div className="shell-terminal" ref={hostRef} style={{ background: palette.background }} />;
}

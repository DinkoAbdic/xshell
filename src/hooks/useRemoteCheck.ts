import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GitRemoteState, GitRepo, Tab } from "../types";
import { useWindowVisible } from "./useWindowVisible";

// A new tab re-checks its project only if the last check is older than this.
const RECHECK_MS = 5 * 60_000;
// Open projects are re-checked this often while the window is on screen.
const POLL_MS = 15 * 60_000;

export interface PullPrompt {
  key: string;         // repo path + upstream commit; "Later" hides the prompt until the upstream moves
  projectName: string;
  repoPath: string;
  rel: string;         // repo folder relative to the project ("" for the project folder itself)
  state: GitRemoteState;
}

const normPath = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

// Fetches every git repo of the projects open in tabs (on launch, when a tab opens a project, and
// every POLL_MS) and queues a prompt for each repo whose branch is behind its upstream, e.g. after
// commits were pushed from another computer. Fetches run one at a time in the background.
export function useRemoteCheck(tabs: Tab[], enabled: boolean) {
  const [prompts, setPrompts] = useState<PullPrompt[]>([]);
  const windowVisible = useWindowVisible();
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const lastCheckRef = useRef(new Map<string, number>()); // normalized project path -> ms
  const seenTabsRef = useRef(new Set<string>());
  const declinedRef = useRef(new Set<string>());
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const check = useCallback((projectPath: string, projectName: string) => {
    lastCheckRef.current.set(normPath(projectPath), Date.now());
    queueRef.current = queueRef.current.then(async () => {
      const repos = await invoke<GitRepo[]>("find_git_repos", { root: projectPath }).catch(() => [] as GitRepo[]);
      for (const repo of repos) {
        const state = await invoke<GitRemoteState | null>("git_fetch_remote", { cwd: repo.path }).catch(() => null);
        if (!state || state.behind === 0) continue;
        const key = `${normPath(repo.path)}|${state.upstream_hash}`;
        if (declinedRef.current.has(key)) continue;
        const prompt: PullPrompt = { key, projectName, repoPath: repo.path, rel: repo.rel, state };
        setPrompts(prev => {
          const i = prev.findIndex(p => normPath(p.repoPath) === normPath(repo.path));
          if (i < 0) return [...prev, prompt];
          const next = prev.slice();
          next[i] = prompt;
          return next;
        });
      }
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    for (const t of tabs) {
      if (t.type !== "terminal" || !t.projectPath || seenTabsRef.current.has(t.id)) continue;
      seenTabsRef.current.add(t.id);
      const last = lastCheckRef.current.get(normPath(t.projectPath));
      if (last == null || Date.now() - last > RECHECK_MS) check(t.projectPath, t.projectName || baseName(t.projectPath));
    }
  }, [tabs, enabled, check]);

  useEffect(() => {
    if (!enabled || !windowVisible) return;
    const id = window.setInterval(() => {
      for (const t of tabsRef.current) {
        if (t.type !== "terminal" || !t.projectPath) continue;
        const last = lastCheckRef.current.get(normPath(t.projectPath)) ?? 0;
        if (Date.now() - last >= POLL_MS) check(t.projectPath, t.projectName || baseName(t.projectPath));
      }
    }, 60_000);
    return () => window.clearInterval(id);
  }, [enabled, windowVisible, check]);

  // "Later": don't ask again about these commits; a newer push asks again.
  const decline = useCallback((key: string) => {
    declinedRef.current.add(key);
    setPrompts(prev => prev.filter(p => p.key !== key));
  }, []);
  const resolve = useCallback((key: string) => {
    setPrompts(prev => prev.filter(p => p.key !== key));
  }, []);

  return { prompts, decline, resolve };
}

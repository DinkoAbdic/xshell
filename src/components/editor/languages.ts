import type { Extension } from "@codemirror/state";
import { StreamLanguage, type StreamParser } from "@codemirror/language";

// Language support for the code editor, picked by file name / extension. Every language is a
// dynamic import, so Vite splits each into its own chunk and only the ones actually opened load.
type Loader = { label: string; load: () => Promise<Extension> };

const legacy = (p: Promise<StreamParser<unknown>>) => p.then((parser) => StreamLanguage.define(parser));

const js = (opts: { typescript?: boolean; jsx?: boolean }) => () => import("@codemirror/lang-javascript").then((m) => m.javascript(opts));
const css = () => import("@codemirror/lang-css").then((m) => m.css());
const html = () => import("@codemirror/lang-html").then((m) => m.html());
const xml = () => import("@codemirror/lang-xml").then((m) => m.xml());
const json = () => import("@codemirror/lang-json").then((m) => m.json());
const cpp = () => import("@codemirror/lang-cpp").then((m) => m.cpp());
const shell = () => legacy(import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell));
const properties = () => legacy(import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties));

const BY_EXT: Record<string, Loader> = {
  ts: { label: "TypeScript", load: js({ typescript: true }) },
  mts: { label: "TypeScript", load: js({ typescript: true }) },
  cts: { label: "TypeScript", load: js({ typescript: true }) },
  tsx: { label: "TypeScript JSX", load: js({ typescript: true, jsx: true }) },
  js: { label: "JavaScript", load: js({}) },
  mjs: { label: "JavaScript", load: js({}) },
  cjs: { label: "JavaScript", load: js({}) },
  jsx: { label: "JavaScript JSX", load: js({ jsx: true }) },
  json: { label: "JSON", load: json },
  jsonc: { label: "JSON", load: json },
  json5: { label: "JSON", load: json },
  css: { label: "CSS", load: css },
  scss: { label: "SCSS", load: css },
  less: { label: "Less", load: css },
  html: { label: "HTML", load: html },
  htm: { label: "HTML", load: html },
  vue: { label: "Vue", load: html },
  svelte: { label: "Svelte", load: html },
  astro: { label: "Astro", load: html },
  xml: { label: "XML", load: xml },
  svg: { label: "SVG", load: xml },
  xaml: { label: "XAML", load: xml },
  csproj: { label: "XML", load: xml },
  plist: { label: "XML", load: xml },
  rs: { label: "Rust", load: () => import("@codemirror/lang-rust").then((m) => m.rust()) },
  py: { label: "Python", load: () => import("@codemirror/lang-python").then((m) => m.python()) },
  pyw: { label: "Python", load: () => import("@codemirror/lang-python").then((m) => m.python()) },
  md: { label: "Markdown", load: () => import("@codemirror/lang-markdown").then((m) => m.markdown()) },
  mdx: { label: "Markdown", load: () => import("@codemirror/lang-markdown").then((m) => m.markdown()) },
  markdown: { label: "Markdown", load: () => import("@codemirror/lang-markdown").then((m) => m.markdown()) },
  yml: { label: "YAML", load: () => import("@codemirror/lang-yaml").then((m) => m.yaml()) },
  yaml: { label: "YAML", load: () => import("@codemirror/lang-yaml").then((m) => m.yaml()) },
  sql: { label: "SQL", load: () => import("@codemirror/lang-sql").then((m) => m.sql()) },
  java: { label: "Java", load: () => import("@codemirror/lang-java").then((m) => m.java()) },
  c: { label: "C", load: cpp },
  h: { label: "C", load: cpp },
  cpp: { label: "C++", load: cpp },
  cc: { label: "C++", load: cpp },
  cxx: { label: "C++", load: cpp },
  hpp: { label: "C++", load: cpp },
  hh: { label: "C++", load: cpp },
  php: { label: "PHP", load: () => import("@codemirror/lang-php").then((m) => m.php()) },
  go: { label: "Go", load: () => import("@codemirror/lang-go").then((m) => m.go()) },
  toml: { label: "TOML", load: () => legacy(import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml)) },
  sh: { label: "Shell", load: shell },
  bash: { label: "Shell", load: shell },
  zsh: { label: "Shell", load: shell },
  ps1: { label: "PowerShell", load: () => legacy(import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell)) },
  psm1: { label: "PowerShell", load: () => legacy(import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell)) },
  lua: { label: "Lua", load: () => legacy(import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua)) },
  rb: { label: "Ruby", load: () => legacy(import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby)) },
  swift: { label: "Swift", load: () => legacy(import("@codemirror/legacy-modes/mode/swift").then((m) => m.swift)) },
  cs: { label: "C#", load: () => legacy(import("@codemirror/legacy-modes/mode/clike").then((m) => m.csharp)) },
  kt: { label: "Kotlin", load: () => legacy(import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin)) },
  kts: { label: "Kotlin", load: () => legacy(import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin)) },
  dart: { label: "Dart", load: () => legacy(import("@codemirror/legacy-modes/mode/clike").then((m) => m.dart)) },
  ini: { label: "INI", load: properties },
  cfg: { label: "INI", load: properties },
  conf: { label: "INI", load: properties },
  properties: { label: "Properties", load: properties },
  env: { label: "Env", load: properties },
  diff: { label: "Diff", load: () => legacy(import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff)) },
  patch: { label: "Diff", load: () => legacy(import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff)) },
};

const BY_NAME: Record<string, Loader> = {
  dockerfile: { label: "Dockerfile", load: () => legacy(import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile)) },
  ".bashrc": BY_EXT.sh,
  ".zshrc": BY_EXT.sh,
  ".gitignore": BY_EXT.ini,
};

function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1).toLowerCase();
}

export function languageFor(path: string): Loader | null {
  const name = fileName(path);
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith(".env")) return BY_EXT.env; // .env, .env.local, ...
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? BY_EXT[name.slice(dot + 1)] ?? null : null;
}

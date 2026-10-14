import { StateEffect, StateField, RangeSet, Text, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, gutter, GutterMarker, type ViewUpdate } from "@codemirror/view";
import { Chunk } from "@codemirror/merge";

// Change markers in the gutter (VS Code-style): lines added / modified since HEAD, and a small
// mark where lines were deleted. The HEAD version is pushed in with `setGitBase`.

export const setGitBase = StateEffect.define<string | null>();
const refresh = StateEffect.define<null>();

const baseField = StateField.define<Text | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGitBase)) return e.value === null ? null : Text.of(e.value.split(/\r\n?|\n/));
    return value;
  },
});

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: "added" | "modified" | "deleted") { super(); this.elementClass = `cm-git-${kind}`; }
  eq(other: ChangeMarker) { return other.kind === this.kind; }
  toDOM() { return document.createElement("span"); }
}
const added = new ChangeMarker("added");
const modified = new ChangeMarker("modified");
const deleted = new ChangeMarker("deleted");

function computeMarkers(doc: Text, base: Text | null): RangeSet<GutterMarker> {
  if (!base) return RangeSet.empty;
  const marks: { pos: number; marker: GutterMarker }[] = [];
  for (const ch of Chunk.build(base, doc)) {
    // Chunk ranges are character offsets that end one past the last line break.
    const bEmpty = ch.fromB === ch.toB;
    if (bEmpty) {
      marks.push({ pos: doc.lineAt(Math.min(ch.fromB, doc.length)).from, marker: deleted });
      continue;
    }
    const kind = ch.fromA === ch.toA ? added : modified;
    const first = doc.lineAt(Math.min(ch.fromB, doc.length)).number;
    const last = doc.lineAt(Math.min(ch.toB - 1, doc.length)).number;
    for (let n = first; n <= last; n++) marks.push({ pos: doc.line(n).from, marker: kind });
  }
  marks.sort((a, b) => a.pos - b.pos);
  return RangeSet.of(marks.map((m) => m.marker.range(m.pos)), true);
}

// Recomputes markers off the keystroke path (debounced), then nudges the gutter to redraw.
const markerPlugin = ViewPlugin.fromClass(class {
  markers: RangeSet<GutterMarker>;
  timer: number | undefined;
  constructor(readonly view: EditorView) {
    this.markers = computeMarkers(view.state.doc, view.state.field(baseField));
  }
  update(u: ViewUpdate) {
    const baseChanged = u.startState.field(baseField) !== u.state.field(baseField);
    if (baseChanged) { this.markers = computeMarkers(u.state.doc, u.state.field(baseField)); return; }
    if (!u.docChanged) return;
    this.markers = this.markers.map(u.changes);
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.markers = computeMarkers(this.view.state.doc, this.view.state.field(baseField));
      this.view.dispatch({ effects: refresh.of(null) });
    }, 300);
  }
  destroy() { window.clearTimeout(this.timer); }
});

export function gitGutter(): Extension {
  return [
    baseField,
    markerPlugin,
    gutter({
      class: "cm-git-gutter",
      markers: (view) => view.plugin(markerPlugin)?.markers ?? RangeSet.empty,
    }),
  ];
}

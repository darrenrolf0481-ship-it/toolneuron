import { useEffect, useRef } from "react";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { basicSetup } from "codemirror";

/** Grammar packages load on demand so only the languages in use are downloaded. */
async function languageSupport(language: string): Promise<Extension> {
  switch (language) {
    case "python":
    case "py":
      return (await import("@codemirror/lang-python")).python();
    case "javascript":
    case "js":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "typescript":
    case "ts":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true });
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "markdown":
    case "md":
      return (await import("@codemirror/lang-markdown")).markdown();
    default:
      return [];
  }
}

// Colors come from CSS variables (styles.css) so night and dayglass both work.
const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--color-fg)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.7", overflow: "auto" },
  ".cm-content": { padding: "12px 0", caretColor: "var(--color-primary)" },
  ".cm-line": { padding: "0 12px 0 6px" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--color-muted)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 10px", minWidth: "2rem" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--color-primary) 9%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--color-fg)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-primary)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--color-primary) 35%, transparent)",
  },
  ".cm-matchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--color-primary) 30%, transparent)",
    outline: "1px solid var(--color-border)",
  },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--color-primary) 18%, transparent)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-muted)" },
  ".cm-panels": { backgroundColor: "var(--color-surface)", color: "var(--color-fg)", borderColor: "var(--color-border)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--color-border)" },
  ".cm-textfield": {
    backgroundColor: "var(--color-bg)",
    color: "var(--color-fg)",
    border: "1px solid var(--color-border)",
    borderRadius: "8px",
    fontSize: "13px",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--color-bg)",
    color: "var(--color-fg)",
    border: "1px solid var(--color-border)",
    borderRadius: "8px",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--color-surface)",
    color: "var(--color-fg)",
    border: "1px solid var(--color-border)",
    borderRadius: "10px",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--color-primary)", color: "var(--color-on-primary)" },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier, t.definitionKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.attributeValue], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: "var(--syn-function)" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--syn-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-property)" },
  { tag: [t.self, t.special(t.variableName), t.meta, t.annotation], color: "var(--syn-type)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--syn-punct)" },
  { tag: t.heading, color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: t.link, color: "var(--syn-string)", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.invalid, color: "var(--color-primary)", textDecoration: "underline wavy" },
]);

type Props = {
  /** Changing this swaps the document and starts a fresh undo history. */
  fileId: string;
  value: string;
  language: string;
  wrap: boolean;
  onChange: (value: string) => void;
};

export function CodeEditor({ fileId, value, language, wrap, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;
  const langCompartment = useRef(new Compartment());
  const wrapCompartment = useRef(new Compartment());
  const wrapRef = useRef(wrap);
  wrapRef.current = wrap;

  // One editor per open file.
  useEffect(() => {
    if (!hostRef.current) return;
    const python = language === "python" || language === "py";
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          indentUnit.of(python ? "    " : "  "),
          EditorState.tabSize.of(python ? 4 : 2),
          theme,
          syntaxHighlighting(highlight),
          langCompartment.current.of([]),
          wrapCompartment.current.of(wrapRef.current ? EditorView.lineWrapping : []),
          EditorView.contentAttributes.of({
            "aria-label": "Source editor",
            spellcheck: "false",
            autocapitalize: "off",
            autocorrect: "off",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    let alive = true;
    void languageSupport(language).then((support) => {
      if (alive) view.dispatch({ effects: langCompartment.current.reconfigure(support) });
    });
    return () => {
      alive = false;
      view.destroy();
      viewRef.current = null;
    };
  }, [fileId, language]);

  // External edits (AI wrote the file, template loaded, reset).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: wrapCompartment.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  return <div ref={hostRef} className="h-full min-h-0" />;
}

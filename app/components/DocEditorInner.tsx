"use client";
import { useEffect, useRef } from "react";
import Editor from "@toast-ui/editor";
import "@toast-ui/editor/dist/toastui-editor.css";

export interface Props {
  path: string;
  initialContent: string;
  mode: "raw" | "rendered";
  onChange: (next: string) => void;
  onWikiLinkClick?: (title: string) => void;
  readOnly?: boolean;
}

// SPRINT-036: interactive task-list checkboxes.
// Matches the same task-list shapes ToastMark recognises in the source —
// `- [ ] foo`, `* [x] bar`, `+ [X] baz`, `1. [ ] qux`. The leading prefix is
// captured so the replace preserves indentation + marker style exactly.
//
// Important: Toast UI Editor 3.x renders task items as `<li class="task-list-item">`
// (with a `.checked` modifier class) and paints the checkbox via a `::before`
// pseudo-element background-image. There is no `<input type="checkbox">` in
// the rendered DOM — earlier shaping of this code that looked for input
// elements was a no-op. We target the `<li>` directly.
//
// The `(?=[ \t]+\S)` lookahead requires at least one same-line trailing
// space/tab + a non-whitespace char after `]`. ToastMark only renders a
// bullet as a task-list-item when it has content after the bracket — a
// bare `- [ ]` placeholder is rendered as plain "[ ]" text instead. The
// lookahead aligns the regex with ToastMark's parser so the Nth match in
// the source matches the Nth `li.task-list-item` in the DOM. Without it,
// placeholder rows shift the index and clicks toggle the wrong line.
const TASK_RE = /^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\](?=[ \t]+\S)/gm;
// Width of the ::before pseudo-element checkbox area (18px image + a small
// padding buffer) — clicks within this leading slot toggle the task; clicks
// beyond it on the text are ignored so users can still select / read.
const CHECKBOX_HIT_PX = 24;

function toggleNthTask(src: string, n: number): string {
  let i = 0;
  return src.replace(TASK_RE, (full, prefix: string, char: string) => {
    if (i++ !== n) return full;
    const toggled = char === " " ? "x" : " ";
    return `${prefix}[${toggled}]`;
  });
}

export function DocEditorInner({ path, initialContent, mode, onChange, onWikiLinkClick, readOnly }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onWikiLinkClickRef = useRef(onWikiLinkClick);
  onWikiLinkClickRef.current = onWikiLinkClick;

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;
    const editor = new Editor({
      el: host,
      initialValue: initialContent,
      previewStyle: "vertical",
      height: "100%",
      initialEditType: "markdown",
      hideModeSwitch: true,
      usageStatistics: false,
      // GFM extended autolink: bare URLs typed without [text](url) syntax
      // render as clickable <a>. ToastMark runs autolink before the text
      // node is emitted, so the customHTMLRenderer.text override below
      // never sees URL-shaped text (wiki-links unaffected — they don't
      // match URL patterns).
      extendedAutolinks: true,
      toolbarItems: [
        ["heading", "bold", "italic", "strike"],
        ["hr", "quote"],
        ["ul", "ol", "task", "indent", "outdent"],
        ["table", "image", "link"],
        ["code", "codeblock"],
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      customHTMLRenderer: {
        text(node: any) {
          const literal: string = node.literal ?? "";
          const escaped = literal
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          const html = escaped.replace(/\[\[([^\]]+)\]\]/g, (_: string, title: string) => {
            const safe = title.replace(/"/g, "&quot;");
            return `<span class="wiki-link" title="${safe}">${title}</span>`;
          });
          return [{ type: "html", content: html }];
        },
      },
      events: {
        change: () => {
          if (!readOnly) onChangeRef.current(editor.getMarkdown());
          // SPRINT-036 re-tagging: the MutationObserver below catches every
          // preview re-render, so we don't need a manual call here.
        },
      },
    });
    editorRef.current = editor;
    if (readOnly) host.classList.add("doc-editor-readonly");

    // SPRINT-036: tag preview-pane task-list LIs with a stable linear index
    // so the click handler can locate the matching bracket in the markdown
    // source. The cursor cue makes interactivity discoverable; we don't
    // change the painted checkbox itself.
    //
    // MutationObserver wires this up: Toast UI's preview pane renders
    // asynchronously after the Editor constructor returns, so a single rAF
    // on mount fires before any `.task-list-item` exists in the DOM. The
    // observer fires on every preview re-render (initial load, each
    // keystroke, every setMarkdown), so tagging always reflects current
    // content.
    const tagTaskItems = () => {
      const preview = host.querySelector(".toastui-editor-md-preview");
      if (!preview) return;
      const items = preview.querySelectorAll<HTMLLIElement>("li.task-list-item");
      items.forEach((el, i) => {
        el.dataset.taskIdx = String(i);
        if (!readOnly) el.style.cursor = "pointer";
      });
    };
    const observer = new MutationObserver(() => tagTaskItems());
    observer.observe(host, { childList: true, subtree: true });
    requestAnimationFrame(tagTaskItems);

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Wiki-link click — navigate via parent (existing).
      const link = target.closest(".wiki-link") as HTMLElement | null;
      if (link && onWikiLinkClickRef.current) {
        onWikiLinkClickRef.current(link.getAttribute("title") ?? link.textContent ?? "");
        return;
      }

      // SPRINT-036: task-list click — Toast UI paints the checkbox as the
      // `::before` of `<li class="task-list-item">`, so we detect clicks on
      // the leading slot of that LI. We only toggle when the click X is
      // inside the painted checkbox area (CHECKBOX_HIT_PX); clicks on the
      // text portion are ignored so the user can still select / read.
      if (readOnly) return;
      const li = target.closest<HTMLLIElement>("li.task-list-item");
      if (li && li.closest(".toastui-editor-md-preview") && li.dataset.taskIdx !== undefined) {
        const liRect = li.getBoundingClientRect();
        const clickX = e.clientX - liRect.left;
        if (clickX > CHECKBOX_HIT_PX) return;
        e.preventDefault();
        const ed = editorRef.current;
        if (!ed) return;
        const idx = Number(li.dataset.taskIdx);
        if (!Number.isFinite(idx)) return;
        const md = ed.getMarkdown();
        const next = toggleNthTask(md, idx);
        if (next !== md) {
          // setMarkdown re-renders the preview (which the MutationObserver
          // re-tags). Call onChange explicitly because Toast UI doesn't
          // guarantee its `change` event for programmatic setMarkdown across
          // versions.
          ed.setMarkdown(next);
          onChangeRef.current(next);
        }
      }
    };
    host.addEventListener("click", handleClick);

    return () => {
      observer.disconnect();
      host.removeEventListener("click", handleClick);
      editor.destroy();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (ed.getMarkdown() !== initialContent) ed.setMarkdown(initialContent);
  }, [initialContent]);

  return <div ref={hostRef} data-mode={mode} data-readonly={readOnly ? "true" : undefined} style={{ height: "100%" }} />;
}

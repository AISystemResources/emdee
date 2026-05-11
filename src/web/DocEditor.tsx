import { useEffect, useRef } from "react";
import Editor from "@toast-ui/editor";
import "@toast-ui/editor/dist/toastui-editor.css";

interface Props {
  path: string;
  initialContent: string;
  mode: "raw" | "rendered";
  onChange: (next: string) => void;
  onWikiLinkClick?: (title: string) => void;
}

export function DocEditor({ path, initialContent, mode, onChange, onWikiLinkClick }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onWikiLinkClickRef = useRef(onWikiLinkClick);
  onWikiLinkClickRef.current = onWikiLinkClick;

  // Create editor once per `path` (key change => fresh instance).
  // Always stays in markdown mode — raw vs rendered is handled by CSS
  // hiding either the source pane or the preview pane.
  useEffect(() => {
    if (!hostRef.current) return;
    const editor = new Editor({
      el: hostRef.current,
      initialValue: initialContent,
      previewStyle: "vertical",
      height: "100%",
      initialEditType: "markdown",
      hideModeSwitch: true,
      usageStatistics: false,
      customHTMLRenderer: {
        text(node: any) {
          const text: string = node.literal ?? "";
          if (!text.includes("[[")) return [{ type: "text", content: text }];
          const tokens: object[] = [];
          let last = 0;
          const re = /\[\[([^\]]+)\]\]/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) !== null) {
            if (m.index > last) tokens.push({ type: "text", content: text.slice(last, m.index) });
            const title = m[1];
            const parts = title.split(" — ");
            const display = parts.length > 1 ? parts[parts.length - 1] : title;
            tokens.push({ type: "html", content: `<span class="wiki-link" title="${title}">${display}</span>` });
            last = m.index + m[0].length;
          }
          if (last < text.length) tokens.push({ type: "text", content: text.slice(last) });
          return tokens;
        },
      },
      toolbarItems: [
        ["heading", "bold", "italic", "strike"],
        ["hr", "quote"],
        ["ul", "ol", "task", "indent", "outdent"],
        ["table", "image", "link"],
        ["code", "codeblock"],
      ],
      events: {
        change: () => onChangeRef.current(editor.getMarkdown()),
      },
    });
    editorRef.current = editor;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest(".wiki-link") as HTMLElement | null;
      if (link && onWikiLinkClickRef.current) {
        onWikiLinkClickRef.current(link.getAttribute("title") ?? link.textContent ?? "");
      }
    };
    hostRef.current.addEventListener("click", handleClick);

    return () => {
      hostRef.current?.removeEventListener("click", handleClick);
      editor.destroy();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Pull in external content changes (e.g. file watcher reload) without resetting cursor
  // when the user is the one who typed the change.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (ed.getMarkdown() !== initialContent) {
      ed.setMarkdown(initialContent);
    }
  }, [initialContent]);

  return <div ref={hostRef} data-mode={mode} style={{ height: "100%" }} />;
}

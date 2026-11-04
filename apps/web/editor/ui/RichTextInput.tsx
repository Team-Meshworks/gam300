import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import type { TextMark, TextRun } from "../../shared/project/project-content";
import { editTextRuns } from "./text-runs";

export type RichTextInputHandle = { focus: () => void; selection: () => readonly [number, number] };
function offsets(root: HTMLElement, target?: StaticRange): readonly [number, number] | null {
  const selection = window.getSelection();
  if (!target && !selection?.rangeCount) return null;
  const selected = target ?? selection!.getRangeAt(0);
  if (!root.contains(selected.startContainer) || !root.contains(selected.endContainer)) return null;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(selected.startContainer, selected.startOffset);
  const start = range.toString().length;
  range.setEnd(selected.endContainer, selected.endOffset);
  return [start, range.toString().length];
}
function restore(root: HTMLElement, [start, end]: readonly [number, number]) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  let offset = 0;
  let began = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!began && start <= offset + length) {
      range.setStart(node, Math.max(0, start - offset));
      began = true;
    }
    if (began && end <= offset + length) {
      range.setEnd(node, Math.max(0, end - offset));
      break;
    }
    offset += length;
  }
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
function signature(runs: readonly TextRun[]) {
  const merged: { text: string; marks: string }[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const marks = [...run.marks].sort().join(",");
    const previous = merged.at(-1);
    if (previous?.marks === marks) previous.text += run.text;
    else merged.push({ text: run.text, marks });
  }
  return JSON.stringify(merged);
}
function domRuns(root: HTMLElement): TextRun[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const runs: TextRun[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const marks = new Set<TextMark>();
    for (
      let parent = node.parentElement;
      parent && parent !== root;
      parent = parent.parentElement
    ) {
      if (parent.tagName === "STRONG") marks.add("bold");
      if (parent.tagName === "EM") marks.add("italic");
      if (parent.tagName === "U") marks.add("underline");
    }
    runs.push({ text: node.textContent ?? "", marks: [...marks] });
  }
  return runs;
}

// One native editing surface: the caret and formatted text share the same glyph layout.
export const RichTextInput = forwardRef<
  RichTextInputHandle,
  {
    value: readonly TextRun[];
    marks: readonly TextMark[];
    onChange: (runs: readonly TextRun[]) => void;
    onFormat: (mark: TextMark) => void;
  }
>(function RichTextInput({ value, marks, onChange, onFormat }, ref) {
  const element = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const editRange = useRef<readonly [number, number] | null>(null);
  const deleteBackward = useRef<boolean | null>(null);
  const selected = useRef<readonly [number, number]>([0, 0]);
  useImperativeHandle(
    ref,
    () => ({
      focus: () => element.current?.focus({ preventScroll: true }),
      selection: () =>
        element.current ? (offsets(element.current) ?? selected.current) : selected.current,
    }),
    [],
  );
  useLayoutEffect(() => {
    const root = element.current!;
    // Capture the affected range before the browser removes or replaces DOM text
    const beforeInput = (event: InputEvent) => {
      const target = event.getTargetRanges()[0];
      editRange.current = target ? offsets(root, target) : offsets(root);
      // Plaintext-only editors can omit target ranges; retain deletion direction and the pre-edit caret
      deleteBackward.current =
        !target && event.inputType.startsWith("delete")
          ? event.inputType.endsWith("Backward")
          : null;
    };
    root.addEventListener("beforeinput", beforeInput);
    return () => root.removeEventListener("beforeinput", beforeInput);
  }, []);
  useLayoutEffect(() => {
    const root = element.current;
    if (!root || composing.current || signature(domRuns(root)) === signature(value)) return;
    const current = offsets(root);
    const active = document.activeElement === root;
    const scroll = root.scrollTop;
    const fragment = document.createDocumentFragment();
    for (const run of value) {
      let node: Node = document.createTextNode(run.text);
      for (const mark of run.marks) {
        const wrapper = document.createElement(
          mark === "bold" ? "strong" : mark === "italic" ? "em" : "u",
        );
        wrapper.append(node);
        node = wrapper;
      }
      fragment.append(node);
    }
    root.replaceChildren(fragment);
    if (active) restore(root, current ?? selected.current);
    root.scrollTop = scroll;
  }, [value]);
  function change() {
    const root = element.current!;
    selected.current = offsets(root) ?? selected.current;
    const text = (root.textContent ?? "").slice(0, 65536);
    let range = editRange.current;
    if (range && range[0] === range[1] && deleteBackward.current !== null) {
      const removed = value.reduce((length, run) => length + run.text.length, 0) - text.length;
      if (removed > 0) {
        range = deleteBackward.current
          ? [range[0] - removed, range[1]]
          : [range[0], range[1] + removed];
      }
    }
    editRange.current = null;
    deleteBackward.current = null;
    onChange(editTextRuns(value, text, marks, range));
  }
  return (
    <div
      ref={element}
      className="content-rich-input"
      data-empty={value.every((run) => !run.text)}
      role="textbox"
      aria-label="Text"
      aria-multiline="true"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      data-placeholder="Caption, feel free to not type anything!"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.altKey || !(event.ctrlKey || event.metaKey))
          return;
        const key = event.key.toLowerCase();
        const mark =
          key === "b" ? "bold" : key === "i" ? "italic" : key === "u" ? "underline" : null;
        if (!mark) return;
        event.preventDefault();
        event.stopPropagation();
        onFormat(mark);
      }}
      onInput={change}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        change();
      }}
      onKeyUp={() => {
        selected.current = offsets(element.current!) ?? selected.current;
      }}
      onMouseUp={() => {
        selected.current = offsets(element.current!) ?? selected.current;
      }}
    />
  );
});

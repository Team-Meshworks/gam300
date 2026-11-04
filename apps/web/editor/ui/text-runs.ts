import type { TextMark, TextRun } from "../../shared/project/project-content";

// Slice by the textarea's UTF-16 offsets while retaining formatting on untouched characters
function slice(runs: readonly TextRun[], start: number, end: number): TextRun[] {
  let offset = 0;
  return runs.flatMap((run) => {
    const from = Math.max(0, start - offset);
    const to = Math.min(run.text.length, end - offset);
    offset += run.text.length;
    return to > from ? [{ text: run.text.slice(from, to), marks: [...run.marks] }] : [];
  });
}

// Merge adjacent equal marks so ordinary typing does not consume the 256-run format budget
function compact(runs: readonly TextRun[]): TextRun[] {
  const result: TextRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const previous = result.at(-1);
    if (
      previous &&
      previous.marks.length === run.marks.length &&
      previous.marks.every((mark) => run.marks.includes(mark))
    ) {
      result[result.length - 1] = { ...previous, text: previous.text + run.text };
    } else {
      result.push(run);
    }
  }
  return result;
}

export function editTextRuns(
  runs: readonly TextRun[],
  text: string,
  marks: readonly TextMark[],
): TextRun[] {
  const old = runs.map((run) => run.text).join("");
  let start = 0;
  while (start < old.length && start < text.length && old[start] === text[start]) {
    start++;
  }
  let suffix = 0;
  while (
    suffix < old.length - start &&
    suffix < text.length - start &&
    old[old.length - 1 - suffix] === text[text.length - 1 - suffix]
  ) {
    suffix++;
  }
  // Replace only the changed range; imported mixed formatting stays intact around it
  return compact([
    ...slice(runs, 0, start),
    { text: text.slice(start, text.length - suffix), marks: [...marks] },
    ...slice(runs, old.length - suffix, old.length),
  ]);
}

export function markTextRuns(
  runs: readonly TextRun[],
  start: number,
  end: number,
  mark: TextMark,
): TextRun[] {
  const selected = slice(runs, start, end);
  const remove = selected.length > 0 && selected.every((run) => run.marks.includes(mark));
  const length = runs.reduce((sum, run) => sum + run.text.length, 0);
  return compact([
    ...slice(runs, 0, start),
    ...selected.map((run) => ({
      text: run.text,
      marks: remove
        ? run.marks.filter((value) => value !== mark)
        : [...new Set([...run.marks, mark])],
    })),
    ...slice(runs, end, length),
  ]);
}

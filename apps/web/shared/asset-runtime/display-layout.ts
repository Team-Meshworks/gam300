// Fit content without cropping it or stretching its aspect ratio.
export function containDisplay(
  width: number,
  height: number,
  sourceWidth: number,
  sourceHeight: number,
) {
  if (![width, height, sourceWidth, sourceHeight].every((n) => Number.isFinite(n) && n > 0)) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  return { width: sourceWidth * scale, height: sourceHeight * scale };
}

// Bound canvas work even for the maximum imported text size. Preserve explicit newlines.
export function wrapDisplayText(
  text: string,
  maxWidth: number,
  measure: (text: string) => number,
  maxLines = 24,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const character of paragraph) {
      if (line && measure(line + character) > maxWidth) {
        lines.push(line);
        line = "";
        if (lines.length >= maxLines)
          return [...lines.slice(0, maxLines - 1), `${lines[maxLines - 1]}…`];
      }
      line += character;
    }
    lines.push(line);
    if (lines.length >= maxLines) return lines.slice(0, maxLines);
  }
  return lines;
}

// Only grow a confirmation when the extra room actually removes a line of copy.
export function fitConfirmationCopy(dialog: HTMLDialogElement) {
  dialog.style.removeProperty("width");
  const width = dialog.offsetWidth;
  const limit = Math.min(width + 96, document.documentElement.clientWidth - 32);
  if (!width || limit <= width) return;
  const paragraphs = dialog.querySelectorAll<HTMLElement>(
    ".sp-dialog-body > p, .asset-admin-confirmation-content > p",
  );
  const targets = [...paragraphs].filter(hasSingleWordLastLine).map((p) => ({
    p,
    height: p.getBoundingClientRect().height,
  }));
  if (!targets.length) return;
  const fits = (candidate: number) => {
    dialog.style.width = `${candidate}px`;
    return targets.every(({ p, height }) => p.getBoundingClientRect().height < height);
  };
  if (!fits(limit)) {
    dialog.style.removeProperty("width");
    return;
  }
  let lo = width + 1;
  let hi = limit;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) hi = mid;
    else lo = mid + 1;
  }
  dialog.style.width = `${lo}px`;
}

function hasSingleWordLastLine(paragraph: HTMLElement) {
  if (!paragraph.getClientRects().length) return false;
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const words: { node: Node; start: number; end: number }[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    for (const match of (node.textContent ?? "").matchAll(/\S+/g)) {
      words.push({ node, start: match.index, end: match.index + match[0].length });
    }
  }
  const [previous, last] = words.slice(-2).map(({ node, start, end }) => {
    range.setStart(node, start);
    range.setEnd(node, end);
    return range.getBoundingClientRect().bottom;
  });
  return previous !== undefined && last !== undefined && last - previous > 2;
}

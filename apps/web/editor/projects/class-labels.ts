export function classLabels(classes: readonly { id: string; label: string }[]) {
  const counts = new Map<string, number>();
  for (const item of classes) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
  return new Map(
    classes.map((item) => [
      item.id,
      counts.get(item.label)! > 1 ? `${item.label} (${item.id})` : item.label,
    ]),
  );
}

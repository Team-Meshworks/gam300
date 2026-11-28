export function classLabels(classes: readonly { id: string; label: string }[]) {
  const groups = new Map<string, string[]>();
  for (const item of classes) {
    const ids = groups.get(item.label) ?? [];
    ids.push(item.id);
    groups.set(item.label, ids);
  }
  for (const ids of groups.values()) ids.sort();
  return new Map(
    classes.map((item) => {
      const ids = groups.get(item.label)!;
      return [item.id, ids.length > 1 ? `${item.label} (${ids.indexOf(item.id) + 1})` : item.label];
    }),
  );
}

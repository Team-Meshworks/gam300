// Saved projects and recovered edits bypass setup; first-open choice never discards scene content.
export function needsBaseModel(revision: number, role: string, recovered: boolean) {
  return role === "Creator" && revision === 0 && !recovered;
}

// Mirrors the server: case, spacing and punctuation never make two tags different
export function tagKey(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{Nd}]/gu, "");
}

const ALLOWED = /^[\p{L}\p{Nd} \-'&().,]+$/u;

export function normalizeTag(input: string, maxLength: number): string | null {
  const name = input.trim().replace(/\s+/g, " ");
  return name.length > 0 && name.length <= maxLength && ALLOWED.test(name) && tagKey(name)
    ? name
    : null;
}

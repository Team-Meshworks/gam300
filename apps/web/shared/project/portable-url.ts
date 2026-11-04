import punycode from "punycode/";

export const MAX_PORTABLE_URL_LENGTH = 2048;
export const PORTABLE_HTTPS_URL_ERROR = "Expected an absolute HTTPS URL without credentials";

export function isPortableHttpsUrl(url: string): boolean {
  // Match the raw authority before URL can repair missing hosts or reinterpret credentials
  const authority = /^https:\/\/(\[[0-9a-fA-F:.]+\]|[^:/?#@]+)(?::([0-9]{1,5}))?(?=[/?#]|$)/.exec(
    url,
  );
  if (!authority) {
    return false;
  }

  try {
    // Decode only for validation; keep the original authored spelling in the returned document
    const host = decodeURIComponent(authority[1]!);
    const parsed = new URL(url);

    // Native URL parsing handles IPv6 and port range; DNS labels need the shared restrictions below
    const ipv6 = host.startsWith("[");
    const domain = parsed.hostname.replace(/\.$/, "");

    // Some URL runtimes accept fake xn-- labels without checking the encoded characters
    // Decode and parse the Unicode host too, matching the server IDNA check before acceptance
    // Require the same canonical host so decoded delimiters cannot change the authority
    const validIdn = ipv6 || new URL(`https://${punycode.toUnicode(domain)}`).hostname === domain;

    // Reject raw cleanup characters before accepting the parsed host
    // IPv6 bypasses DNS label checks while decoded DNS hosts must also exclude escaped delimiters
    let valid =
      validIdn &&
      !Array.from(url).some(
        (character) =>
          character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || character === "\\",
      ) &&
      !parsed.username &&
      !parsed.password &&
      (ipv6 ||
        (!Array.from(host).some(
          (character) =>
            character.charCodeAt(0) <= 32 ||
            character.charCodeAt(0) === 127 ||
            "%/\\?#@[]:<>^|".includes(character),
        ) &&
          domain.length <= 253 &&
          domain
            .split(".")
            .every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))));

    // Browsers treat numeric suffixes as IPv4; forbid fallback DNS and legacy short or octal forms
    if (
      !ipv6 &&
      [host, domain].some((value) => /(?:^|\.)(?:[0-9]+|0[xX][0-9a-fA-F]*)\.?$/.test(value))
    ) {
      // Inspect authored octets because URL has already normalized legacy IPv4 spellings
      const parts = host.replace(/\.$/, "").split(".");
      valid &&=
        parts.length === 4 &&
        parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
    }

    return valid;
  } catch {
    // Malformed percent escapes, IDN hosts and native parsing failures share the same rejection
    return false;
  }
}

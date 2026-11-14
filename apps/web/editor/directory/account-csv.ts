export type NewAccount = {
  displayName: string;
  userName: string;
  role: "Creator" | "Educator";
  initialPassword: string;
};

function parseRows(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  for (let i = 0; i <= text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === undefined) throw new Error("The CSV has an unclosed quoted field.");
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += char;
    } else if (char === '"' && !field.trim() && !closed) {
      quoted = true;
      field = "";
    } else if (char === separator || char === "\n" || char === "\r" || char === undefined) {
      row.push(field.trim());
      field = "";
      closed = false;
      if (char !== separator) {
        if (row.some(Boolean)) rows.push(row);
        row = [];
        if (char === "\r" && text[i + 1] === "\n") i++;
      }
    } else {
      if ((closed && char.trim()) || char === '"')
        throw new Error("The CSV contains an invalid quoted field.");
      field += char;
    }
  }
  return rows;
}

function birthDate(raw: string): [number, number, number] {
  const numeric = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})$/.exec(raw);
  if (numeric) {
    if (numeric[1]!.length === 4)
      return [Number(numeric[1]), Number(numeric[2]), Number(numeric[3])];
    if (numeric[3]!.length === 4) {
      const first = Number(numeric[1]),
        second = Number(numeric[2]);
      return [
        Number(numeric[3]),
        second > 12 && first <= 12 ? first : second,
        second > 12 && first <= 12 ? second : first,
      ];
    }
  }
  const words = raw
    .replace(/,/g, " ")
    .replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1")
    .split(/[\s./-]+/)
    .filter(Boolean);
  const monthIndex = words.findIndex((word) =>
    /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/i.test(
      word,
    ),
  );
  if (words.length === 3 && monthIndex >= 0) {
    const yearIndex = words.findIndex((word) => /^\d{4}$/.test(word));
    const dayIndex = words.findIndex(
      (word, index) => index !== yearIndex && index !== monthIndex && /^\d{1,2}$/.test(word),
    );
    const month =
      ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(
        words[monthIndex]!.slice(0, 3).toLowerCase(),
      ) + 1;
    if (yearIndex >= 0 && dayIndex >= 0)
      return [Number(words[yearIndex]), month, Number(words[dayIndex])];
  }
  return [NaN, NaN, NaN];
}

export async function readAccountCsv(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export function importAccounts(text: string, role: NewAccount["role"]): NewAccount[] {
  text = text.replace(/^\uFEFF/, "").trimStart();
  const directive = /^sep=([,;\t|])(?:\r\n|\r|\n)/i.exec(text);
  if (directive) text = text.slice(directive[0].length);
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const isName = (value: string) =>
    ["name", "fullname", "studentname", "learnername", "creatorname", "facilitatorname"].includes(
      normalize(value),
    );
  const isDob = (value: string) =>
    ["dob", "dateofbirth", "birthdate", "birthday"].includes(normalize(value));
  let rows: string[][] | undefined;
  for (const separator of directive ? [directive[1]!] : [",", ";", "\t", "|"]) {
    try {
      const candidate = parseRows(text, separator);
      if (candidate[0]?.some(isName) && candidate[0]?.some(isDob)) {
        rows = candidate;
        break;
      }
    } catch {
      /* Try the other separators before rejecting the file. */
    }
  }
  if (!rows)
    throw new Error("Include a Name column and a DOB or Date of Birth column in a valid CSV.");
  const headers = rows.shift()!;
  if (headers.filter(isName).length !== 1 || headers.filter(isDob).length !== 1)
    throw new Error("Use only one Name column and one DOB column.");
  const isRole = (value: string) => ["accounttype", "role"].includes(normalize(value));
  if (headers.filter(isRole).length > 1)
    throw new Error("Use only one Account Type or Role column.");
  const roleIndex = headers.findIndex(isRole);
  const nameIndex = headers.findIndex(isName),
    dobIndex = headers.findIndex(isDob);
  if (!rows.length || rows.length > 200)
    throw new Error("Upload between 1 and 200 accounts at a time.");
  const usernames = new Set<string>();
  return rows.map((values, index) => {
    const fail = (message: string): never => {
      throw new Error(`Row ${index + 2}: ${message}`);
    };
    const displayName = values[nameIndex] ?? "";
    if (
      values.length !== headers.length ||
      !displayName ||
      displayName.length > 256 ||
      displayName.includes("\0")
    )
      fail("check the name and columns.");
    const rawRole = roleIndex < 0 ? "" : (values[roleIndex] ?? "").trim().toLowerCase();
    const accountRole = !rawRole
      ? role
      : rawRole === "creator"
        ? "Creator"
        : rawRole === "facilitator" || rawRole === "educator"
          ? "Educator"
          : fail("Account Type must be Creator or Facilitator.");
    const raw = values[dobIndex] ?? "";
    const [year, month, day] = birthDate(raw);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    if (
      !Number.isInteger(year) ||
      year < 1900 ||
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day ||
      date.getTime() > Date.now()
    )
      fail("use a valid DOB with a four-digit year, such as 2008-03-15 or 15 March 2008.");
    const name = displayName
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    if (!name || name.length > 248)
      fail("the name must produce a username of 1–248 Latin letters or numbers.");
    const userName = `${name}${String(day).padStart(2, "0")}${String(month).padStart(2, "0")}${year}`;
    if (usernames.has(userName)) fail("this name and DOB appear more than once.");
    usernames.add(userName);
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return {
      displayName,
      userName,
      role: accountRole,
      initialPassword: `Aa1!${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`,
    };
  });
}

export function downloadCredentials(accounts: NewAccount[]) {
  const cell = (value: string) =>
    `"${(/^[=+@\-\t\r]/.test(value) ? "'" + value : value).replaceAll('"', '""')}"`;
  const rows = [
    ["Name", "Username", "Temporary Password", "Account Type"],
    ...accounts.map((account) => [
      account.displayName,
      account.userName,
      account.initialPassword,
      account.role === "Educator" ? "Facilitator" : "Creator",
    ]),
  ];
  const url = URL.createObjectURL(
    new Blob([rows.map((row) => row.map(cell).join(",")).join("\r\n")], {
      type: "text/csv;charset=utf-8",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "account-credentials.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

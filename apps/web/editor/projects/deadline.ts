const minimumUnixSeconds = -62_135_596_800;
const maximumUnixSeconds = 253_402_300_799;

export function localDateToDueUnixSeconds(value: string): number | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!parts) return null;
  const date = new Date(`${value}T23:59:59`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.getFullYear() !== Number(parts[1]) ||
    date.getMonth() + 1 !== Number(parts[2]) ||
    date.getDate() !== Number(parts[3]) ||
    date.getHours() !== 23 ||
    date.getMinutes() !== 59 ||
    date.getSeconds() !== 59
  )
    return null;
  const seconds = date.getTime() / 1000;
  return seconds >= minimumUnixSeconds && seconds <= maximumUnixSeconds ? seconds : null;
}

export function formatDueDate(seconds: number): string | null {
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < minimumUnixSeconds ||
    seconds > maximumUnixSeconds
  )
    return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(seconds * 1000),
  );
}

export function dueDateInput(seconds: number): string {
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < minimumUnixSeconds ||
    seconds > maximumUnixSeconds
  )
    return "";
  const date = new Date(seconds * 1000);
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function localDeadlineToUnixSeconds(value: string): number | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!parts) return null;
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date.getFullYear() !== Number(parts[1]) ||
    date.getMonth() + 1 !== Number(parts[2]) ||
    date.getDate() !== Number(parts[3]) ||
    date.getHours() !== Number(parts[4]) ||
    date.getMinutes() !== Number(parts[5])
  )
    return null;
  const seconds = date.getTime() / 1000;
  return seconds >= minimumUnixSeconds && seconds <= maximumUnixSeconds ? seconds : null;
}

export function formatLocalDeadline(seconds: number): string | null {
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < minimumUnixSeconds ||
    seconds > maximumUnixSeconds
  )
    return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(seconds * 1000),
  );
}

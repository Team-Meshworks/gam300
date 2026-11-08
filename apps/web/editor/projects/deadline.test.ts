import { expect, it } from "vitest";
import {
  localDeadlineInput,
  formatDueDate,
  formatLocalDeadline,
  localDateToDueUnixSeconds,
  localDeadlineToUnixSeconds,
} from "./deadline";

it("shows the local date and time of an existing deadline", () => {
  const seconds = 2_000_000_000;
  const local = new Date(seconds * 1000);
  expect(localDeadlineInput(seconds)).toBe(
    `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}T${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`,
  );
});

it("maps a valid local date and time to Unix seconds", () => {
  expect(localDeadlineToUnixSeconds("2028-02-29T15:30")).toBe(
    new Date("2028-02-29T15:30").getTime() / 1000,
  );
  expect(formatLocalDeadline(localDeadlineToUnixSeconds("2028-02-29T15:30")!)).toBeTruthy();
});

it("rejects invalid, incomplete and out-of-range deadlines", () => {
  for (const value of ["2028-02-30T15:30", "2028-02-29", "2028-02-29T25:00", "0000-01-01T00:00"])
    expect(localDeadlineToUnixSeconds(value)).toBeNull();
  for (const value of [-62_135_596_801, 253_402_300_800, 1.5, Number.NaN])
    expect(formatLocalDeadline(value)).toBeNull();
});

it("treats a selected due date as the end of that local day and displays just its date", () => {
  const deadline = localDateToDueUnixSeconds("2028-02-29");
  expect(deadline).toBe(new Date(2028, 1, 29, 23, 59, 59).getTime() / 1000);
  expect(formatDueDate(deadline!)).toBe(
    new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(deadline! * 1000)),
  );
});

it("rejects impossible date-only deadlines", () => {
  for (const value of ["2028-02-30", "2028-13-01", "2028-02-29T15:30", "0000-01-01"])
    expect(localDateToDueUnixSeconds(value)).toBeNull();
});

import { expect, it } from "vitest";
import { formatLocalDeadline, localDeadlineToUnixSeconds } from "./deadline";

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

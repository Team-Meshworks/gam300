import { expect, it, vi } from "vitest";
import { withPublicationSession } from "./publication-session";

const expected = { userId: "teacher", orgId: "school-a" };
const session = {
  ...expected,
  role: "Educator" as const,
  displayName: "Teacher",
  mustChangePassword: false,
};

it("does not send a publication step after the organisation changes", async () => {
  const send = vi.fn(async () => ({ kind: "confirmed" as const }));
  expect(
    await withPublicationSession(expected, async () => ({ ...session, orgId: "school-b" }), send),
  ).toEqual({ kind: "unknown" });
  expect(send).not.toHaveBeenCalled();
});

it("treats a response after an organisation switch as uncertain", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(session)
    .mockResolvedValueOnce({ ...session, orgId: "school-b" });
  const send = vi.fn(async () => ({ kind: "confirmed" as const }));
  expect(await withPublicationSession(expected, read, send)).toEqual({ kind: "unknown" });
  expect(send).toHaveBeenCalledOnce();
});

it("accepts a confirmed result only while the same educator session remains active", async () => {
  const send = vi.fn(async () => ({ kind: "confirmed" as const, value: "receipt" }));
  expect(await withPublicationSession(expected, async () => session, send)).toEqual({
    kind: "confirmed",
    value: "receipt",
  });
});

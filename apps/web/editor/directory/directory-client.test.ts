import { expect, it, vi } from "vitest";
import { createDirectoryClient } from "./directory-client";

const user = {
  userId: "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e",
  displayName: "Aisyah Abdullah",
  userName: "aisyah",
  role: "Creator",
  orgId: "ef580108-e406-4c8e-ac76-75cd41e9d2dc",
  isActive: true,
  mustChangePassword: true,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
it("loads every page within the selected organisation", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ items: [user], nextCursor: user.userId }))
    .mockResolvedValueOnce(json({ items: [], nextCursor: null }));
  expect(await createDirectoryClient(request).accounts(user.orgId)).toEqual([user]);
  expect(String(request.mock.calls[1]?.[0])).toContain(
    `orgId=${user.orgId}&limit=100&cursor=${user.userId}`,
  );
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    credentials: "same-origin",
    cache: "no-store",
  });
});
it("sends only overridden fields with a fresh CSRF token", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ requestToken: "csrf" }))
    .mockResolvedValueOnce(json(user));
  await createDirectoryClient(request).update(user.userId, { displayName: "Aisyah Abdullah" });
  expect(request.mock.calls[1]?.[1]).toMatchObject({
    method: "PATCH",
    headers: { "X-CSRF-TOKEN": "csrf" },
    body: JSON.stringify({ displayName: "Aisyah Abdullah" }),
  });
});
it("reports duplicate usernames without returning a successful account", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ requestToken: "csrf" }))
    .mockResolvedValueOnce(json({ code: "username_taken" }, 409));
  await expect(
    createDirectoryClient(request).create(user.orgId, {
      displayName: user.displayName,
      userName: user.userName,
      role: "Creator",
      initialPassword: "Synthetic-password1!",
    }),
  ).rejects.toThrow("already taken");
});
it("rejects malformed accounts, repeated cursors and unverified CSRF responses", async () => {
  const invalid = vi.fn<typeof fetch>().mockResolvedValue(json({ ...user, role: "Superuser" }));
  await expect(createDirectoryClient(invalid).getAccount(user.userId)).rejects.toThrow(
    "invalid account",
  );
  const repeated = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => json({ items: [user], nextCursor: user.userId }));
  await expect(createDirectoryClient(repeated).accounts(user.orgId)).rejects.toThrow(
    "finish loading",
  );
  const csrf = vi.fn<typeof fetch>().mockResolvedValue(json({ requestToken: "" }));
  await expect(
    createDirectoryClient(csrf).update(user.userId, { displayName: "Name" }),
  ).rejects.toThrow("verified");
  expect(csrf).toHaveBeenCalledTimes(1);
});
it("does not retry an unconfirmed write automatically", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ requestToken: "csrf" }))
    .mockRejectedValueOnce(new Error("network"));
  await expect(
    createDirectoryClient(request).update(user.userId, { userName: "new" }),
  ).rejects.toThrow("refresh the directory");
  expect(request).toHaveBeenCalledTimes(2);
});

import { expect, it, vi } from "vitest";
import type { AccountSession } from "./account-client";
import { createWorkspaceAccount } from "./workspace-account";

const user: AccountSession = {
  userId: "user-a",
  orgId: "class-a",
  displayName: "Ms Tan",
  role: "Educator",
  mustChangePassword: false,
};

it("retains a same-account workspace across a password challenge but drops it for another organisation", async () => {
  const getSession = vi.fn().mockResolvedValue(user);
  const account = createWorkspaceAccount({ getSession, signOut: vi.fn() });
  await account.check();
  getSession.mockResolvedValue({ ...user, mustChangePassword: true });
  await account.check();
  expect(account.getSnapshot()).toEqual({
    kind: "password-required",
    workspace: user,
  });
  getSession.mockResolvedValue({
    ...user,
    mustChangePassword: true,
    orgId: "class-b",
  });
  await account.check();
  expect(account.getSnapshot()).toEqual({
    kind: "password-required",
    workspace: null,
  });
});

it("rejects a stale logout and sends just one account-bound write, even during a focus check", async () => {
  let finish!: () => void;
  const signOut = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
  const getSession = vi.fn().mockResolvedValue(user);
  const account = createWorkspaceAccount({ getSession, signOut });
  await account.check();
  await account.signOut({ ...user, role: "Creator" });
  expect(signOut).not.toHaveBeenCalled();
  const pending = account.signOut(user);
  await account.signOut(user);
  await account.check();
  expect(account.getSnapshot().kind).toBe("signing-out");
  expect(signOut.mock.calls).toEqual([[user.userId]]);
  expect(getSession).toHaveBeenCalledTimes(1);
  finish();
  await pending;
  expect(account.getSnapshot()).toEqual({
    kind: "signed-out",
    workspace: null,
  });
});

it("retains unchanged identity after verification and propagates changed account capabilities", async () => {
  const getSession = vi.fn().mockResolvedValue({ ...user });
  const account = createWorkspaceAccount({ getSession, signOut: vi.fn() });
  await account.check();
  const original = account.getSnapshot().workspace;
  await account.check();
  expect(getSession).toHaveBeenCalledTimes(2);
  expect(account.getSnapshot().workspace).toBe(original);
  getSession.mockResolvedValue({ ...user, developmentAssetsAllowed: true });
  await account.check();
  expect(account.getSnapshot().workspace).not.toBe(original);
  expect(account.getSnapshot().workspace?.developmentAssetsAllowed).toBe(true);
});

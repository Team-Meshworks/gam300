import type { NewAccount } from "./account-csv";

type CreatedAccount = Pick<NewAccount, "displayName" | "userName" | "role"> & { userId: string };
export type BulkImportSummary = {
  operationId: string;
  createdAt: string;
  expiresAt: string;
  createdCount: number;
};

export type BulkImportReview = {
  operationId: string;
  created: CreatedAccount[];
  available: number;
  expiresAt: string;
  acknowledged: boolean;
};

type Receipt = BulkImportReview & { credentials: NewAccount[] };
type DirectoryWrite = (
  path: string,
  method: string,
  body: object,
  timeout?: number,
) => Promise<unknown>;
type DirectoryRead = (path: string) => Promise<unknown>;

const id = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";
const row = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export class ImportRejected extends Error {}

export class ImportRequestError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("The account import state changed. Check its receipt.");
    this.code = code;
  }
}

function receipt(
  value: unknown,
  orgId: string,
  operationId: string,
  submitted?: readonly NewAccount[],
): Receipt {
  const invalid = () =>
    new Error("The import receipt could not be verified. Check the same import again.");
  if (
    !row(value) ||
    value.operationId !== operationId ||
    value.orgId !== orgId ||
    typeof value.acknowledged !== "boolean" ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    !Array.isArray(value.created) ||
    value.created.length > 200 ||
    !Array.isArray(value.credentials) ||
    value.credentials.length > value.created.length ||
    (value.acknowledged && value.credentials.length)
  )
    throw invalid();
  const byId = new Map<string, CreatedAccount>();
  const names = new Set<string>();
  for (const item of value.created) {
    if (
      !row(item) ||
      !id(item.userId) ||
      typeof item.userName !== "string" ||
      !item.userName ||
      typeof item.displayName !== "string" ||
      !item.displayName ||
      (item.role !== "Creator" && item.role !== "Educator") ||
      byId.has(item.userId) ||
      names.has(item.userName) ||
      (submitted &&
        !submitted.some(
          (input) =>
            input.userName === item.userName &&
            input.displayName === item.displayName &&
            input.role === item.role,
        ))
    )
      throw invalid();
    names.add(item.userName);
    byId.set(item.userId, {
      userId: item.userId,
      userName: item.userName,
      displayName: item.displayName,
      role: item.role,
    });
  }
  const exported = new Set<string>();
  const credentials: NewAccount[] = [];
  for (const item of value.credentials) {
    if (
      !row(item) ||
      !id(item.userId) ||
      exported.has(item.userId) ||
      typeof item.password !== "string" ||
      item.password.length < 12 ||
      item.password.length > 128
    )
      throw invalid();
    const account = byId.get(item.userId);
    if (!account || account.userName !== item.userName) throw invalid();
    exported.add(item.userId);
    credentials.push({
      userName: account.userName,
      displayName: account.displayName,
      role: account.role,
      initialPassword: item.password,
    });
  }
  return {
    operationId,
    created: [...byId.values()],
    credentials,
    available: credentials.length,
    expiresAt: value.expiresAt,
    acknowledged: value.acknowledged,
  };
}

export function createBulkImport(
  actorId: string,
  orgId: string,
  write: DirectoryWrite,
  read: DirectoryRead,
) {
  if (!id(actorId) || !id(orgId))
    throw new Error("The organisation or administrator could not be verified.");
  const key = `spatia.bulk-import:${actorId}:${orgId}`;
  const collection = `/api/v1/admin/organizations/${orgId}/bulk-imports`;
  function pending(): string | null {
    const operation = localStorage.getItem(key);
    if (operation !== null && !id(operation))
      throw new Error(
        "The import reference could not be read. Check the directory before starting another import.",
      );
    return operation;
  }
  function watch(listener: () => void) {
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === key || event.key === null))
        listener();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }
  function clear(operationId: string) {
    if (localStorage.getItem(key) === operationId) {
      localStorage.removeItem(key);
      if (localStorage.getItem(key) === operationId)
        throw new Error("The browser could not clear this import reference.");
    }
  }
  function base(operationId: string) {
    if (!id(operationId)) throw new Error("The import identifier could not be verified.");
    return `${collection}/${operationId}`;
  }
  function locked<T>(action: () => Promise<T>): Promise<T> {
    if (!navigator.locks) throw new Error("This browser cannot safely coordinate account imports.");
    return navigator.locks.request(key, action);
  }
  async function verifyActor() {
    const session = await read("/api/v1/auth/session");
    if (
      !row(session) ||
      session.userId !== actorId ||
      session.role !== "Administrator" ||
      session.mustChangePassword !== false
    )
      throw new Error(
        "Your account changed. Sign in with the administrator who started the import.",
      );
  }
  async function checked(value: unknown, operationId: string, submitted?: readonly NewAccount[]) {
    await verifyActor();
    return receipt(value, orgId, operationId, submitted);
  }
  async function load(operationId: string) {
    return checked(await write(base(operationId) + "/receipt", "POST", {}), operationId);
  }
  async function discover(): Promise<BulkImportSummary[]> {
    const invalid = () =>
      new Error("The account import list could not be verified. Refresh the directory.");
    const result = new Map<string, BulkImportSummary>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await read(`${collection}?limit=20${cursor ? `&cursor=${cursor}` : ""}`);
      if (
        !row(page) ||
        !Array.isArray(page.items) ||
        page.items.length > 20 ||
        (page.nextCursor !== null && !id(page.nextCursor))
      )
        throw invalid();
      for (const item of page.items) {
        if (
          !row(item) ||
          !id(item.operationId) ||
          result.has(item.operationId) ||
          typeof item.createdAt !== "string" ||
          !Number.isFinite(Date.parse(item.createdAt)) ||
          typeof item.expiresAt !== "string" ||
          !Number.isFinite(Date.parse(item.expiresAt)) ||
          Date.parse(item.createdAt) > Date.parse(item.expiresAt) ||
          typeof item.createdCount !== "number" ||
          !Number.isSafeInteger(item.createdCount) ||
          item.createdCount < 0 ||
          item.createdCount > 200
        )
          throw invalid();
        result.set(item.operationId, {
          operationId: item.operationId,
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
          createdCount: item.createdCount,
        });
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw invalid();
      if (cursor) cursors.add(cursor);
    } while (cursor);
    await verifyActor();
    return [...result.values()].sort(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        a.operationId.localeCompare(b.operationId),
    );
  }
  return {
    pending,
    watch,
    discover,
    async start(values: readonly NewAccount[]) {
      return locked(async () => {
        if (pending())
          throw new Error("Resolve the previous account import before starting another.");
        const operationId = crypto.randomUUID();
        localStorage.setItem(key, operationId);
        if (pending() !== operationId)
          throw new Error("The browser could not safely record the import. No accounts were sent.");
        let value: unknown;
        try {
          value = await write(
            base(operationId),
            "PUT",
            values.map((item) => ({ ...item, orgId })),
            90000,
          );
        } catch (cause) {
          if (cause instanceof ImportRejected) clear(operationId);
          throw cause;
        }
        return checked(value, operationId, values);
      });
    },
    load: (operationId: string) => locked(() => load(operationId)),
    acknowledge: (operationId: string) =>
      locked(async () => {
        const ack = await write(base(operationId) + "/acknowledge", "POST", {});
        if (ack !== null) throw new Error("The handoff acknowledgement could not be verified.");
        clear(operationId);
      }),
    abandon: (operationId: string) =>
      locked(async () => {
        if (pending() !== operationId)
          throw new Error("The local import changed. Reopen the directory.");
        const ack = await write(base(operationId) + "/abandon", "POST", {});
        if (ack !== null) throw new Error("The import cancellation could not be verified.");
        clear(operationId);
      }),
  };
}

export type BulkImport = ReturnType<typeof createBulkImport>;

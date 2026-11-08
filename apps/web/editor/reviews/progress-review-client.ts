import { ReviewError } from "./review-client";

export interface ProgressReview {
  id: string;
  feedback: string;
  createdAt: string;
  revision: number;
}
export interface ProgressIntent {
  reviewId: string;
  expectedRevision: number;
  feedback: string;
}
const invalid = () => new ReviewError("The review service returned an invalid response.");
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const uuid = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))
    throw invalid();
  return value.toLowerCase();
};
function parse(value: unknown): ProgressReview {
  const r = object(value);
  if (
    typeof r.feedback !== "string" ||
    typeof r.createdAt !== "string" ||
    !Number.isFinite(Date.parse(r.createdAt)) ||
    typeof r.revision !== "number" ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 0
  )
    throw invalid();
  return { id: uuid(r.id), feedback: r.feedback, createdAt: r.createdAt, revision: r.revision };
}
export function createProgressReviewClient(request: typeof fetch = fetch) {
  const path = (projectId: string) => `/api/v1/projects/${uuid(projectId)}/progress-reviews`;
  const send = (url: string, init: RequestInit = {}) =>
    request(url, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  async function read(response: Response): Promise<unknown> {
    if (!response.ok)
      throw new ReviewError(
        response.status === 409
          ? "The saved project changed. Refresh its status before saving your review."
          : response.status === 401
            ? "Your session has expired. Sign in again."
            : response.status === 403 || response.status === 404
              ? "This project is no longer available to your account."
              : "Reviews could not be loaded. Try again.",
        response.status,
      );
    if (!response.headers.get("content-type")?.includes("application/json")) throw invalid();
    return response.json();
  }
  return {
    async list(
      projectId: string,
      actorId: string,
      role: "Creator" | "Educator",
      cursor?: string | null,
    ) {
      const r = object(
        await read(
          await send(path(projectId) + "?limit=20" + (cursor ? `&cursor=${uuid(cursor)}` : ""), {
            headers: { "X-Spatia-Account": uuid(actorId) },
          }),
        ),
      );
      if (!Array.isArray(r.items)) throw invalid();
      const session = object(await read(await send("/api/v1/auth/session")));
      if (
        uuid(session.userId) !== uuid(actorId) ||
        session.role !== role ||
        session.mustChangePassword !== false
      )
        throw new ReviewError("Your account changed. Reload before viewing reviews.");
      return {
        items: r.items.map(parse),
        nextCursor: r.nextCursor === null ? null : uuid(r.nextCursor),
      };
    },
    async save(
      projectId: string,
      actorId: string,
      intent: ProgressIntent,
    ): Promise<
      | { kind: "confirmed"; item: ProgressReview }
      | { kind: "rejected"; error: ReviewError }
      | { kind: "unknown" }
    > {
      let token: string;
      try {
        const value = object(
          await read(
            await send("/api/v1/auth/csrf", { headers: { "X-Spatia-Account": uuid(actorId) } }),
          ),
        );
        if (typeof value.requestToken !== "string" || !value.requestToken) throw invalid();
        token = value.requestToken;
      } catch (error) {
        return { kind: "rejected", error: error instanceof ReviewError ? error : invalid() };
      }
      let response: Response;
      try {
        response = await send(path(projectId), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-TOKEN": token,
            "X-Spatia-Account": uuid(actorId),
          },
          body: JSON.stringify(intent),
        });
      } catch {
        return { kind: "unknown" };
      }
      if (response.status >= 500) return { kind: "unknown" };
      if (!response.ok) {
        try {
          await read(response);
        } catch (error) {
          return { kind: "rejected", error: error instanceof ReviewError ? error : invalid() };
        }
      }
      try {
        if (response.status !== 200 && response.status !== 201) return { kind: "unknown" };
        const item = parse(await read(response));
        if (
          item.id !== uuid(intent.reviewId) ||
          item.feedback !== intent.feedback ||
          item.revision !== intent.expectedRevision
        )
          return { kind: "unknown" };
        return { kind: "confirmed", item };
      } catch {
        return { kind: "unknown" };
      }
    },
  };
}

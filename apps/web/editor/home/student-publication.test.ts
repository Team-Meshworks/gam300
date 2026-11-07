import { expect, it, vi } from "vitest";
import { readStudentPublication } from "./student-publication";

const project = "11111111-1111-4111-8111-111111111111";
const publication = "22222222-2222-4222-8222-222222222222";
const actor = "33333333-3333-4333-8333-333333333333";

it("returns the current authorised link and keeps the request bound to the student", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) =>
    Response.json(
      String(input).includes("/auth/session")
        ? { userId: actor, mustChangePassword: false }
        : {
            items: [
              {
                publicationId: publication,
                sourceRevision: 3,
                createdAt: "2026-11-08T00:00:00Z",
                visitorUrl: `https://spatia.example/p/${publication}`,
              },
            ],
          },
    ),
  );
  const result = await readStudentPublication(project, actor, fetcher);
  expect(result?.visitorUrl).toBe(`https://spatia.example/p/${publication}`);
  expect(fetcher).toHaveBeenCalledWith(
    `/api/v1/projects/${project}/publication-links`,
    expect.objectContaining({ headers: { "X-Spatia-Account": actor }, credentials: "same-origin" }),
  );
});

it("does not display a link when the account changes or the response is unsafe", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) =>
    Response.json(
      String(input).includes("/auth/session")
        ? { userId: "44444444-4444-4444-8444-444444444444", mustChangePassword: false }
        : {
            items: [
              {
                publicationId: publication,
                sourceRevision: 3,
                createdAt: "2026-11-08T00:00:00Z",
                visitorUrl: "https://evil.example/other",
              },
            ],
          },
    ),
  );
  await expect(readStudentPublication(project, actor, fetcher)).rejects.toThrow();
});

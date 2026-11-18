import { expect, it } from "vitest";
import { serveHttp, serveResponses } from "../../tests/http-fixture";
import { classroom, createClassroomClient } from "./classroom-api";

const classId = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const organizationId = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const studentId = "aefea67c-caca-4300-923c-937f1c785578";
const json = (items: unknown[]) =>
  new Response(JSON.stringify({ items, nextCursor: null }), {
    headers: { "Content-Type": "application/json" },
  });

it("retains organisation identity and rejects inconsistent class lists", async () => {
  const row = { id: classId, name: "History", organizationId };
  const { fetch: request } = await serveResponses(json([row]), json([row, row]));
  expect(await createClassroomClient(request).classes()).toEqual([row]);
  await expect(createClassroomClient(request).classes()).rejects.toThrow("inconsistent");
  expect(() => classroom({ ...row, organizationId: null })).toThrow("verified");
});
it("reads enrolled and eligible students from their distinct authorised routes", async () => {
  const { fetch: request, requests } = await serveHttp(({ url }) =>
    new URL(url).pathname.endsWith("/eligible-students")
      ? json([{ userId: studentId, userName: "Alice", enrolled: true }])
      : json([
          {
            userId: studentId,
            userName: "Alice",
            accountActive: true,
            roleId: "862d776c-4d56-4dd8-919d-26044b6d8a44",
          },
        ]),
  );
  expect(await createClassroomClient(request).roster(classId)).toEqual({
    members: [{ userId: studentId, userName: "Alice", accountActive: true, role: "Creator" }],
    eligible: [{ userId: studentId, userName: "Alice", enrolled: true }],
  });
  expect(requests.map(({ url }) => url.replace(new URL(url).origin, "")).toSorted()).toEqual([
    `/api/v1/classes/${classId}/eligible-students?limit=20`,
    `/api/v1/classes/${classId}/roster?limit=20`,
  ]);
});
it("does not manufacture roster permissions from an unknown role or invalid enrolment", async () => {
  for (const badRole of [true, false]) {
    const { fetch: request } = await serveHttp(({ url }) =>
      new URL(url).pathname.endsWith("/eligible-students")
        ? json([{ userId: studentId, userName: "Alice", enrolled: badRole ? false : "true" }])
        : json([
            {
              userId: studentId,
              userName: "Alice",
              accountActive: true,
              roleId: badRole ? "unknown" : "862d776c-4d56-4dd8-919d-26044b6d8a44",
            },
          ]),
    );
    await expect(createClassroomClient(request).roster(classId)).rejects.toThrow("verified");
  }
});

import { describe, expect, it } from "vitest";
import { publicationAcknowledgement } from "./publication-client";

const projectId = "11111111-1111-4111-8111-111111111111";
const publicationId = "22222222-2222-4222-8222-222222222222";
const request = {
  publicationId,
  confirmedRevision: 7,
  intent: { audience: "Authenticated", viewerIds: [] },
};
const ack = {
  projectId,
  publicationId,
  sourceRevision: 7,
  createdAt: "2026-11-05T00:00:00Z",
  visitorUrl: `https://spatia.test/p/${publicationId}`,
};

describe("publication acknowledgement", () => {
  it("exposes only the matching committed visitor link", () => {
    expect(publicationAcknowledgement(ack, projectId, request)).toEqual(ack);
  });
  it.each([
    { sourceRevision: 8 },
    { projectId: publicationId },
    { publicationId: projectId },
    { visitorUrl: `https://spatia.test/api/v1/publications/${publicationId}` },
    { visitorUrl: `javascript:alert(1)` },
    { createdAt: "invalid" },
    { visitorUrl: `https://user:password@spatia.test/p/${publicationId}` },
  ])("rejects an unrelated or invalid acknowledgement", (change) => {
    expect(publicationAcknowledgement({ ...ack, ...change }, projectId, request)).toBeNull();
  });
});

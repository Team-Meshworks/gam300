import { describe, expect, it } from "vitest";
import { parsePublicationReference, publicationAccessState } from "./publication-access";

const publicationId = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const projectId = "8ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const viewerId = "9ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const state = {
  publicationId,
  projectId,
  audience: "Authenticated",
  viewerIds: [viewerId],
  hidden: false,
  revoked: false,
  deleted: false,
  archived: false,
  canManage: true,
};

describe("publication access boundaries", () => {
  it("accepts a publication ID or a clean HTTPS visitor link", () => {
    expect(parsePublicationReference(publicationId.toUpperCase())).toBe(
      publicationId.toUpperCase(),
    );
    expect(parsePublicationReference(`https://example.com/p/${publicationId}`)).toBe(publicationId);
    for (const input of [
      "not-an-id",
      `http://example.com/p/${publicationId}`,
      `https://example.com/p/${publicationId}?x=1`,
      `https://example.com/p/${publicationId}/extra`,
      `https://user@example.com/p/${publicationId}`,
    ]) {
      expect(parsePublicationReference(input)).toBeNull();
    }
  });

  it("accepts only verified access data for the requested project and publication", () => {
    expect(publicationAccessState(state, projectId, publicationId)).toEqual(state);
    expect(
      publicationAccessState({ ...state, projectId: viewerId }, projectId, publicationId),
    ).toBeNull();
    expect(
      publicationAccessState({ ...state, publicationId: viewerId }, projectId, publicationId),
    ).toBeNull();
    expect(
      publicationAccessState({ ...state, canManage: "yes" }, projectId, publicationId),
    ).toBeNull();
    expect(
      publicationAccessState(
        { ...state, viewerIds: [viewerId, viewerId.toUpperCase()] },
        projectId,
        publicationId,
      ),
    ).toBeNull();
    expect(
      publicationAccessState({ ...state, audience: "Unknown" }, projectId, publicationId),
    ).toBeNull();
  });
});

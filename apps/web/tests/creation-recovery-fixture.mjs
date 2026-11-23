import assert from "node:assert/strict";

export function creationRecoveryFixture() {
  const heads = new Map();
  return {
    async handle(route, actor) {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (!path.startsWith("/api/v1/creation-operations/")) return false;
      const [, , , , purpose, operationId, action] = path.split("/");
      assert.ok(["project", "duplicate", "class", "import", "assignment-source"].includes(purpose));
      assert.equal(request.headers()["x-spatia-account"], actor);
      const key = actor + "/" + purpose;
      const head = heads.get(key) ?? { state: "ready", operationId: null, receipt: null };
      if (request.method() === "GET") {
        assert.equal(operationId, undefined);
        await route.fulfill({ json: head, headers: { "Cache-Control": "no-store" } });
      } else {
        assert.equal(request.method(), "POST");
        assert.equal(action, "acknowledge");
        assert.equal(operationId, head.operationId);
        assert.equal(request.headers()["x-csrf-token"], "test-token");
        assert.deepEqual(request.postDataJSON(), {});
        heads.set(key, { state: "ready", operationId, receipt: null });
        await route.fulfill({ status: 204 });
      }
      return true;
    },
    commit(request, receipt) {
      const { operationId, creationGuard } = request.postDataJSON();
      const key = request.headers()["x-spatia-account"] + "/" + creationGuard.purpose;
      const previous = heads.get(key);
      if (previous?.operationId !== operationId) {
        assert.equal(previous?.state ?? "ready", "ready");
        assert.equal(creationGuard.previousOperationId, previous?.operationId ?? null);
        heads.set(key, { state: "unacknowledged", operationId, receipt });
      }
      return receipt;
    },
  };
}

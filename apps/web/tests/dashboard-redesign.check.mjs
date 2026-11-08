import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./browser-security.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5182";
const browser = await launchBrowser({ target: origin });
const userId = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const orgId = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const classId = "a9f15e21-026d-4200-baca-0ba9bd411842";
const ids = [
  "aefea67c-caca-4300-923c-937f1c785578",
  "bbf2b1d0-b388-4df8-a995-930148dcdd19",
  "cc0ec5ca-2991-403f-8527-d566028345ab",
];
const publicationId = "ddeea67c-caca-4300-923c-937f1c785578";
const titles = ["The Silk Road: A Journey Through History", "Life in Ancient Rome", "Ocean Life"];
const states = ["pending", "approved", "draft"];
const projects = ids.map((projectId, index) => ({
  projectId,
  title: titles[index],
  revision: 1,
  updatedAt: "2026-10-30T01:00:00Z",
  archived: false,
  permissions: { canEdit: true, canManage: true, canPublish: true },
}));
const assignments = ids.map((projectId, index) => ({
  assignmentId: projectId,
  title: titles[index],
  description:
    "Create an interactive virtual museum exploring the Silk Road and its influence on trade, culture and communication between ancient civilisations. Arrange historical artefacts, add informative exhibits and design an immersive space for visitors to explore.",
  instructions: "Instructions",
  dueAtUnixSeconds: 1800000000,
  assignedBy: "Ms Tan",
  projects: [{ projectId, studentId: userId, studentName: "Student", reviewState: states[index] }],
}));
const failures = [];
await mkdir("../../.artifacts/dashboard-check", { recursive: true });
try {
  for (const role of ["Educator", "Creator"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("503"))
        errors.push(message.text());
    });
    page.on("response", (response) => {
      if (response.status() >= 400 && !new URL(response.url()).pathname.startsWith("/api/"))
        errors.push(`${response.status()} ${response.url()}`);
    });
    let publicationFailure = false;
    let emptyPublications = false;
    let revoked = false;
    let grantOnPublication = false;
    let listReads = 0;
    const requests = [];
    let holdPublication = false;
    let releasePublication;
    const publicationGate = new Promise((resolve) => {
      releasePublication = resolve;
    });
    const publicationRequests = [];
    if (process.env.CHECK_PACKAGED_CSP) {
      const caddy = readFileSync(new URL("../../../deploy/app.Caddyfile", import.meta.url), "utf8");
      const policy = caddy.match(/Content-Security-Policy "([^"]+)"/)?.[1];
      assert.ok(policy, "The packaged server must define its CSP");
      await page.route("**/home", async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          headers: { ...response.headers(), "content-security-policy": policy },
        });
      });
    }
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/v1/auth/session") {
        requests.push("session");
        return route.fulfill({
          json: {
            userId,
            orgId,
            role,
            displayName: role === "Educator" ? "Ms Tan" : "Student",
            mustChangePassword: false,
          },
        });
      }
      if (path === "/api/v1/projects") {
        listReads++;
        if (holdPublication) await publicationGate;
        return route.fulfill({
          json: { items: revoked ? projects.slice(1) : projects, nextCursor: null },
        });
      }
      if (path === "/api/v1/classes")
        return route.fulfill({
          json: { items: [{ id: classId, name: "History" }], nextCursor: null },
        });
      if (path === `/api/v1/classes/${classId}/assignments`)
        return route.fulfill({ json: { items: assignments, nextCursor: null } });
      if (path.endsWith("/submissions") || path.endsWith("/progress-reviews"))
        return route.fulfill({ json: { items: [], nextCursor: null } });
      if (path === "/api/v1/projects/publication-links") {
        if (grantOnPublication) {
          revoked = false;
          grantOnPublication = false;
        }
        requests.push("publication");
        publicationRequests.push({
          path,
          account: request.headers()["x-spatia-account"],
          limit: new URL(request.url()).searchParams.get("limit"),
        });
        if (holdPublication) await publicationGate;
        if (publicationFailure) return route.fulfill({ status: 503 });
        return route.fulfill({
          json: {
            items: !emptyPublications
              ? [
                  {
                    projectId: revoked ? ids[1] : ids[0],
                    publicationId,
                    sourceRevision: 1,
                    createdAt: "2026-10-30T01:00:00Z",
                    visitorUrl: `https://spatia.example/p/${publicationId}`,
                    requiresSignIn: revoked,
                  },
                ]
              : [],
            nextCursor: null,
          },
        });
      }
      if (path === `/api/v1/projects/${ids[0]}/publication-links`)
        return route.fulfill({
          json: {
            items: [
              {
                publicationId,
                sourceRevision: 1,
                createdAt: "2026-10-30T01:00:00Z",
                visitorUrl: `https://spatia.example/p/${publicationId}`,
              },
            ],
          },
        });
      if (path === `/api/v1/projects/${ids[1]}/publication-links`)
        return route.fulfill({ json: { items: [] } });
      return route.fulfill({ status: 404 });
    });
    async function capture(name) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${name} overflows at ${width}`,
        );
        const card = await page
          .locator(role === "Educator" ? ".sp-teacher-card" : ".sp-student-card")
          .first()
          .boundingBox();
        assert.ok(
          card && card.width > 0 && card.x >= 0 && card.x + card.width <= width,
          `${name} card is clipped at ${width}`,
        );
        await page.screenshot({
          path: `../../.artifacts/dashboard-check/${name}-${width}.png`,
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    try {
      await page.goto(origin + "/home");
      assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
      const skip = page.getByRole("link", { name: "Skip to workspace" });
      assert.ok((await skip.boundingBox()).y < 0);
      await page.keyboard.press("Tab");
      assert.equal(await skip.evaluate((node) => node === document.activeElement), true);
      assert.ok((await skip.boundingBox()).y >= 0);
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      if (process.env.CHECK_PACKAGED_CSP) {
        assert.ok(
          (await page.evaluate(() => document.fonts.load("16px Satoshi"))).length > 0,
          "Satoshi font loaded under CSP",
        );
        assert.ok((await page.locator("svg").count()) > 0, "Offline icons rendered under CSP");
      }
      if (role === "Educator") {
        await page.getByText(titles[0], { exact: true }).waitFor();
        await capture("facilitator");
        for (const [name, visible, hidden] of [
          ["Awaiting Approval", titles[0], [titles[1], titles[2]]],
          ["Completed", titles[1], [titles[0], titles[2]]],
          ["In Progress", titles[2], [titles[0], titles[1]]],
        ]) {
          await page.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
          assert.equal(await page.getByText(visible, { exact: true }).isVisible(), true);
          for (const title of hidden)
            assert.equal(await page.getByText(title, { exact: true }).count(), 0);
          if (name === "Completed") {
            const details = page.getByRole("button", { name: "View Details" });
            await details.click();
            await page.getByRole("heading", { name: "Project details" }).waitFor();
            await page.getByRole("button", { name: "Close project details" }).click();
            assert.equal(
              await page.getByRole("tab", { name: /^Completed/ }).getAttribute("aria-selected"),
              "true",
            );
            assert.equal(await page.getByText(titles[0], { exact: true }).count(), 0);
            assert.equal(await details.evaluate((node) => node === document.activeElement), true);
          }
        }
        await page.getByRole("tab", { name: /^All Projects/ }).click();
        const search = page.getByRole("searchbox", { name: "Search projects" });
        await search.fill("no matching project");
        assert.equal(await page.getByText(titles[0], { exact: true }).count(), 0);
        await page.getByText(/no projects match/i).waitFor();
        await search.fill("silk");
        await page.getByText(titles[0], { exact: true }).waitFor();
        assert.equal(await page.getByText(titles[1], { exact: true }).count(), 0);
        await search.fill("");
        await page.getByRole("button", { name: "View Details" }).first().click();
        await page.getByRole("heading", { name: "Project details" }).waitFor();
        await page.getByRole("button", { name: "Close project details" }).click();
      } else {
        await page.getByText(titles[0], { exact: true }).waitFor();
        await capture("creator-projects");
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        const settings = page.getByRole("dialog", { name: "Settings" });
        await settings.waitFor();
        await settings.getByRole("switch", { name: "Dark mode" }).focus();
        await page.keyboard.press("Space");
        assert.equal(
          await settings.getByRole("switch", { name: "Dark mode" }).getAttribute("aria-checked"),
          "true",
        );
        await page.keyboard.press("Escape");
        assert.equal(await settings.count(), 0);
        assert.equal(
          await page
            .getByRole("button", { name: "Settings", exact: true })
            .evaluate((node) => node === document.activeElement),
          true,
        );
        await page.getByRole("tab", { name: "Projects", exact: true }).focus();
        await page.keyboard.press("ArrowRight");
        await page.getByText(titles[0], { exact: true }).waitFor();
        holdPublication = true;
        await page.getByRole("tab", { name: "Projects", exact: true }).click();
        const publicationRead = page.waitForRequest(
          (request) => new URL(request.url()).pathname === "/api/v1/projects/publication-links",
        );
        await page.keyboard.press("ArrowRight");
        await publicationRead;
        assert.equal(
          await page
            .getByRole("tab", { name: "Published", exact: true })
            .getAttribute("aria-selected"),
          "true",
        );
        const loading = page.getByRole("status").filter({ hasText: "Loading published projects" });
        await loading.waitFor();
        assert.equal(await page.getByText(titles[0], { exact: true }).count(), 0);
        const placeholder = await loading.locator(".sp-student-card").boundingBox();
        assert.ok(placeholder && placeholder.width > 500 && placeholder.height > 100);
        holdPublication = false;
        releasePublication();
        await page.getByText(titles[0], { exact: true }).waitFor();
        assert.equal(await loading.count(), 0);
        assert.equal(await page.getByText(titles[1], { exact: true }).count(), 0);
        assert.equal(await page.getByText("Ocean Life", { exact: true }).count(), 0);
        await capture("creator-published");
        const linkField = page.getByRole("textbox", { name: "Share your project" });
        assert.equal(await linkField.inputValue(), `https://spatia.example/p/${publicationId}`);
        assert.equal(await linkField.getAttribute("readonly"), "");
        await page.evaluate(() =>
          Object.defineProperty(navigator, "clipboard", {
            value: { writeText: () => Promise.reject() },
          }),
        );
        await page.getByRole("button", { name: "Copy", exact: true }).click();
        await page.getByText("Select the link and copy it.").waitFor();
        assert.equal(await linkField.evaluate((node) => node === document.activeElement), true);
        assert.ok(publicationRequests.length > 0);
        assert.ok(
          publicationRequests.every(
            (request) =>
              request.path === "/api/v1/projects/publication-links" &&
              request.limit === "20" &&
              request.account === userId,
          ),
        );
        const preview = page.getByRole("link", { name: /preview/i });
        assert.equal(
          await preview.getAttribute("href"),
          `https://spatia.example/p/${publicationId}`,
        );
        await page.getByRole("tab", { name: "Projects", exact: true }).click();
        await page
          .getByRole("button", { name: /view details/i })
          .first()
          .click();
        await page.getByRole("region", { name: "Project details" }).waitFor();
        await page.getByRole("button", { name: "Close project details" }).click();
        publicationFailure = true;
        await page.reload();
        await page.getByText(titles[0], { exact: true }).waitFor();
        await page.getByText(titles[1], { exact: true }).waitFor();
        revoked = true;
        await page.getByRole("tab", { name: "Published", exact: true }).click();
        await page.getByRole("alert").waitFor();
        const listsBeforeRetry = listReads;
        publicationFailure = false;
        await page.getByRole("button", { name: /retry/i }).click();
        await page.getByText(titles[1], { exact: true }).waitFor();
        assert.ok(listReads > listsBeforeRetry, "Retry refreshes project access");
        assert.equal(await page.getByText(titles[0], { exact: true }).count(), 0);
        assert.equal(
          requests.at(-1),
          "session",
          "The session is checked after publication metadata",
        );
        await page.getByText("Only permitted viewers can open this link.").waitFor();
        await page.getByRole("tab", { name: "Projects", exact: true }).click();
        await page
          .locator("article")
          .filter({ hasText: titles[1] })
          .getByRole("button", { name: /view details/i })
          .click();
        await page.getByText("No unlisted link is available for this project.").waitFor();
        await page.getByRole("button", { name: "Close project details" }).click();
        emptyPublications = true;
        await page.getByRole("tab", { name: "Published", exact: true }).click();
        await page.getByText(/no published projects/i).waitFor();
        assert.equal(await page.getByText(titles[0], { exact: true }).count(), 0);
        assert.ok(
          publicationRequests.every(
            (request) => request.limit === "20" && request.account === userId,
          ),
        );
        revoked = false;
        emptyPublications = false;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await page.getByText(titles[0], { exact: true }).waitFor();
        revoked = true;
        await page.reload();
        await page.getByText(titles[1], { exact: true }).waitFor();
        assert.equal(await page.getByText(titles[0], { exact: true }).count(), 0);
        grantOnPublication = true;
        await page.getByRole("tab", { name: "Published", exact: true }).click();
        await page.getByText(titles[0], { exact: true }).waitFor();
      }
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${role} overflows at ${width}`,
        );
        await page.screenshot({
          path: `../../.artifacts/dashboard-check/${role}-${width}.png`,
          fullPage: true,
        });
      }
      assert.deepEqual(errors, []);
    } catch (error) {
      failures.push(`${role}: ${error.message}\nBody: ${await page.locator("body").innerText()}`);
    } finally {
      await page.close();
    }
  }
  assert.deepEqual(failures, []);
  console.log("Dashboard filters, search and authorized published projects passed.");
} finally {
  await browser.close();
}

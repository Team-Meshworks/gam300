import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:5182/ui-preview.html";
const browser = await launchBrowser({ target: baseUrl });
try {
  const singapore = await browser.newContext({ timezoneId: "Asia/Singapore", locale: "en-GB" });
  const newYork = await browser.newContext({ timezoneId: "America/New_York", locale: "en-GB" });
  const teacher = await singapore.newPage();
  const student = await newYork.newPage();
  await Promise.all([teacher.goto(baseUrl), student.goto(baseUrl)]);
  const saved = await teacher.evaluate(async () => {
    const deadline = await import("/projects/deadline.ts");
    return deadline.localDeadlineToUnixSeconds("2026-12-01T15:30");
  });
  assert.equal(saved, Date.parse("2026-12-01T07:30:00Z") / 1000);
  const teacherDisplay = await teacher.evaluate(async (seconds) => {
    const deadline = await import("/projects/deadline.ts");
    return deadline.formatLocalDeadline(seconds);
  }, saved);
  const studentDisplay = await student.evaluate(async (seconds) => {
    const deadline = await import("/projects/deadline.ts");
    return deadline.formatLocalDeadline(seconds);
  }, saved);
  assert.match(teacherDisplay, /15:30/);
  assert.match(studentDisplay, /02:30/);
  const transition = await student.evaluate(async () => {
    const deadline = await import("/projects/deadline.ts");
    return {
      gap: deadline.localDeadlineToUnixSeconds("2026-03-08T02:30"),
      repeat: deadline.localDeadlineToUnixSeconds("2026-11-01T01:30"),
    };
  });
  assert.equal(transition.gap, null);
  assert.equal(transition.repeat, Date.parse("2026-11-01T05:30:00Z") / 1000);
  await Promise.all([singapore.close(), newYork.close()]);
  console.log("Device-local deadline checks passed in Singapore and New York");
} finally {
  await browser.close();
}

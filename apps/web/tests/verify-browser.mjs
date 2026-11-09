import { launchBrowser } from "./browser-security.mjs";
const browser = await launchBrowser({ target: "http://127.0.0.1" });
await browser.close();

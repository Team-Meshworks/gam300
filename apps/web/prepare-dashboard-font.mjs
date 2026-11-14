import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// Fontshare permits self-hosting but not redistributing Satoshi in a repository
const file = new URL("./editor/home/assets/satoshi.woff2", import.meta.url);
const digest = "e739aff9b4d02c264341d6d4872edcda28e79373aeda936f659566a1cd3eb47f";
const matches = (bytes) => createHash("sha256").update(bytes).digest("hex") === digest;
const cached = await readFile(file).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
if (!cached || !matches(cached)) {
  const response = await fetch(
    "https://cdn.fontshare.com/wf/NWBQYJIM7GCZ5XWD7D26ARB3VDY55ZRT/K63EV2KZIGKLE7RANQ2U42S6SVHU5RJ7/X6XYTKIVDUW7GZTZPZNN4EUM5KH54KHF.woff2",
    { signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok) throw new Error("Could not download the dashboard font from Fontshare.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!matches(bytes)) throw new Error("Fontshare returned a different Satoshi font file.");
  await writeFile(file, bytes);
}

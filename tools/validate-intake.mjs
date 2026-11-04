import { validateGlb } from "./asset-content-validation.mjs";

// Bound stdin independently of HTTP limits and never accept a user-supplied file path
const parts = [];
let size = 0;
try {
  for await (const part of process.stdin) {
    size += part.length;
    if (size > 20 * 1024 * 1024)
      throw new Error("Asset exceeds the 20 MB limit");
    parts.push(part);
  }

  // Reuse the catalogue validator after the complete bounded body arrives
  const report = await validateGlb(Buffer.concat(parts));

  // Keep stdout machine-readable for the API and report only bounded warning codes
  process.stdout.write(
    JSON.stringify({
      valid: true,
      messages: report.issues.messages
        .filter((issue) => issue.severity === 1)
        .slice(0, 20)
        .map((issue) => issue.code),
    }),
  );
} catch {
  // Return one safe invalid-content result without echoing uploaded content or parser internals
  process.stdout.write(
    JSON.stringify({
      valid: false,
      messages: ["File is not a supported self-contained static GLB"],
    }),
  );
  process.exitCode = 1;
}

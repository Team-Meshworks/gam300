# Historical integration evidence

This archive records three earlier integration experiments against publication commit `5acec3242446f35e57a8169c1b5a01c5eeca1b8b`. It preserves their source and test evidence for inspection; it is not a production implementation or evidence of current acceptance.

- `scrum161-integration`: original HEAD `760f5fafc2296a2e178d3437cdedac7cf5d6b2e7`.
- `scrum161-review-publication`: original HEAD `072d1915507b506c25e6411eb606a765574fb4dc`.
- `scrum164-publication-check`: original HEAD `ed9aeb6b5dd6855b213d22bbc536e2a2c8db0765`.

Each directory contains a manifest identifying the original HEAD and merge head, recorded status, saved working files and SHA-256 hashes, and the index entries and blob data needed to inspect the staged and unresolved changes. The student-transfer guard found in the experiments is already present in the published SCRUM-161 branch. The remaining unique adapters and harnesses are test-only and must not be treated as production integrations.

To reconstruct a snapshot for review, start a separate detached checkout at its recorded HEAD. Restore the recorded index entries from their saved modes, paths, stages and blob data, preserving conflict stages rather than staging a single resolved file. Restore the saved working and untracked files, then compare their hashes and status with the manifest. Use the locally retained Git metadata if a complete original merge state is needed.

The original scratch folders are retained locally under `.artifacts/`. Their Git metadata and ignored generated outputs are also retained locally; ignored logs and generated outputs are not included in this branch. Treat this archive as a fixed historical record; later integration results need separate evidence.

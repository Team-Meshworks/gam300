# Visitor application

`npm run build:visitor` builds the separate visitor entry. `/p/<publicationId>`
loads the protected snapshot and manifest. The visitor entry does not import the
editor. It checks access on focus
and periodically, and offers sign-in and retry when the exhibition is unavailable.
The login return target is limited to a single local publication path.
Transient 429/503 asset responses retry within a five-minute per-asset budget,
respecting Retry-After. After a load failure, visitors can retry the exhibition
without reloading the page; assets remain hidden until the scene verifies.

Preview opens the shared `ExhibitionPlayer` on a snapshot of the creator's current draft.
Published links use the same player with the published snapshot and its protected asset URLs.

Run `npm run test:player-parity` for the visitor boundary and draft preview
browser checks, including a fixture comparing the editor and visitor walls,
hotspot marker and model transform. Run `npm run test:visitor` against a running visitor server to
check publication loading and navigation.

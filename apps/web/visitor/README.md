# Visitor application

`npm run build:visitor` builds the separate visitor entry. `/p/<publicationId>`
loads the protected snapshot and manifest. The visitor entry does not import the
editor. It checks access on focus
and periodically, and offers sign-in and retry when the exhibition is unavailable.
The login return target is limited to a single local publication path.
Transient 429/503 asset responses retry within a five-minute per-asset budget,
respecting Retry-After. After a load failure, visitors can retry the exhibition
without reloading the page; assets remain hidden until the scene verifies.

The published visitor uses the shared `ExhibitionPlayer` for rendering, media,
interactions and navigation. The editor's Preview instead keeps the live authoring
workspace open in first person, with movement and editing controls. Edits made in
Preview are edits to the draft. Test visitor opens an isolated player to check
visitor interactions and media. Published links continue to serve the published
snapshot and do not load editor code. The publication loader retains access checks;
the API controls publication and asset access.

Run `npm run test:player-parity` for the visitor boundary and editable-preview
browser checks, including a fixture comparing the editor and visitor walls,
hotspot marker and model transform. Run `npm run test:visitor` against a running visitor server to
check publication loading and navigation.

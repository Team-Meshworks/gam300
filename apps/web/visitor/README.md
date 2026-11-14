# Visitor application

`npm run build:visitor` builds the separate visitor entry. `/p/<publicationId>`
loads the protected snapshot and manifest. The visitor entry does not import the
editor. It checks access on focus
and periodically, and offers sign-in and retry when the exhibition is unavailable.
The login return target is limited to a single local publication path.
Transient 429/503 asset responses retry within a five-minute per-asset budget,
respecting Retry-After. After a load failure, visitors can retry the exhibition
without reloading the page; assets remain hidden until the scene verifies.

The visitor and student preview host the shared `ExhibitionPlayer`, including
its renderer, media, hash handling, interactions and navigation. Preview uses an
isolated draft snapshot and supports exit and restart. The player supports legacy
V1 projects and reads older files. The publication loader retains access checks;
the API controls publication and asset access.

Run `npm run test:player-parity` for the shared-player boundary and browser parity
checks. The browser check uses a two-scene mocked API fixture to exercise both
entry points, including model transforms, decoded image, rule-started video,
panel and navigation behavior, saved-draft isolation, and a central scene visual
comparison. Full visitor acceptance requires verification beyond this fixture.

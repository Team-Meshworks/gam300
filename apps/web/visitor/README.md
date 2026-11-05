# Visitor application

`npm run build:visitor` builds the separate visitor entry. `/p/<publicationId>`
loads the protected snapshot and manifest and displays schema-v1 scenes and GLB
assets. The visitor entry does not import the editor. It checks access on focus
and periodically, and offers sign-in and retry when the exhibition is unavailable.
The login return target is limited to a single local publication path.

This is a baseline viewer, not complete visitor-runtime parity: schema-v2 and
unsupported capabilities remain unavailable. The API controls publication and
asset access; the viewer does not grant it. A real HTTPS browser integration has
exercised a named viewer and verified the snapshot and asset hash after an API
host restart. Another physical device, deployment and full visitor acceptance
remain separate verification.

# Organisation directory integration

`OrganizationDirectory` receives only organisations, projects and accounts the current user is authorized to inspect. Its data types are UI adapters, not an API contract; the host and server own access control and authoritative data. Key the directory by identity or authorization context when mounting it. Organisation search persists on return to the list, while the keyed account list resets its query and role filter on a switch.

Project and account dialogs show read-only details through the host's `onPreview` callback. Organisation hide/delete and account changes remain unavailable. The preview uses fictional data and no backend. The directory uses the existing Inter font as a fallback for the Satoshi design; the preview project cover is the referenced Figma asset.

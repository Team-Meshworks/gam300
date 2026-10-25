# Project format

Version 1 remains readable and writable without conversion. Version 2 adds content,
groups, zones, viewpoints and ordered rules. Unsupported future versions are rejected
before replacing an open project. Released-format migration is a separate operation

The wire models are defined in
[TypeScript](../apps/web/shared/project/project-content.ts) and
[C#](../apps/server/Spatia.ProjectFormat/IAuthoredProject.cs). The
[two-scene example](../apps/web/shared/project/fixtures/m2-project.json) exercises the
complete vocabulary. Its media IDs are synthetic validation fixtures

## Identity and scene structure

Entity IDs are UUID strings, unique across the entire project. References compare
UUIDs without letter case while retaining their authored spelling. Asset IDs match
the trusted registry exactly, including case and media kind

Array order defines scene, object, viewpoint, component, rule and action order. Each
scene has one environment and a starting camera. Version 2 requires `groups`, `zones`,
`viewpoints` and `rules`, including empty arrays when unused

Version-2 objects retain the model asset and transform fields and add `parentId`,
`visible` and `components`. A parent is a group or object in the same scene, or null
for the room root. Groups have `id`, `name` and `parentId`. Parent cycles are invalid

Parents organize the hierarchy; object transforms remain in world coordinates.
One environment can contain several connected physical rooms. Walking between those
rooms stays in the same scene; scene navigation is an explicit authored action.
Collapsing the tree and runtime camera, playback or visibility changes do not modify
this authored data. A zone is a unit box centered at the origin before its transform;
its scale gives its full dimensions. Named viewpoints contain a camera pose

## Content

| Type              | Data beyond `id` and `type`                    |
| ----------------- | ---------------------------------------------- |
| `hotspot`         | `label`                                        |
| `text`            | `runs`, `caption`                              |
| `image`           | `assetId`, `caption`, `alt`                    |
| `audio`           | `assetId`, `caption`, `loop`, `volume`, `mode` |
| `video`           | `assetId`, `caption`, `loop`, `volume`         |
| `navigationPoint` | `label`, `sceneId`, `viewpointId`              |

A text run has `text` and a unique list of `bold`, `italic` or `underline` marks.
Text stays literal data. Renderers must use text nodes and supported marks, never
interpret runs as HTML or CSS. Audio mode is `spatial` at its owning object or `global`
without spatial attenuation. Volume is between 0 and 1

## Rules

A rule has a stable `id`, an `enabled` flag, one `trigger` and an ordered, nonempty
`actions` array. Runtime timing and rearming state are not serialized

| Trigger      | Parameters                                      |
| ------------ | ----------------------------------------------- |
| `click`      | `targetId`: object, hotspot or navigation point |
| `zoneEnter`  | `zoneId`                                        |
| `sceneStart` | None                                            |
| `elapsed`    | `seconds`: 0 to 86400                           |
| `gaze`       | `targetId`, `seconds`: 0.1 to 60                |
| `panelClose` | `panelId`: text or image component              |

| Action          | Parameters                                       |
| --------------- | ------------------------------------------------ |
| `showPanel`     | `panelId`: text or image component               |
| `playMedia`     | `mediaId`: audio or video component              |
| `moveCamera`    | `viewpointId`, `durationSeconds`: 0 to 60        |
| `setVisible`    | `objectId`, `visible`                            |
| `navigateScene` | `sceneId`, `viewpointId` belonging to that scene |
| `openLink`      | `url`: absolute HTTPS URL without credentials    |

Trigger and action targets stay in their owning scene except explicit navigation.
Navigation points use the same destination checks. Disabled rules still require valid
fields and references. Unknown variants and extra parameters are rejected

## Limits and validation

| Resource                                 | Limit                                        |
| ---------------------------------------- | -------------------------------------------- |
| JSON document                            | 5 MiB of UTF-8; nesting depth 32             |
| Scenes                                   | 1 to 16 in version 2; exactly 1 in version 1 |
| Objects / groups per scene               | 200 / 200                                    |
| Components per object                    | 16                                           |
| Zones / viewpoints per scene             | 64 / 64                                      |
| Rules per scene / actions per rule       | 256 / 16                                     |
| Text runs / total run text per component | 256 / 65536                                  |
| Caption or alternative text              | 4096                                         |
| Version-2 names and asset IDs            | 256                                          |
| External link                            | 2048                                         |

Text lengths use UTF-16 code units in both implementations. Invalid Unicode and
duplicate JSON fields are rejected. Position axes remain within -10000 to 10000 metres,
quaternions must be unit length within 0.000001 and camera FOV stays between 30 degrees and
90 degrees. Version-2 scale axes must be positive and no greater than 10000. Version 1
retains its released positive-scale limit

Use `deserializeProject` / `serializeProject` in the browser and
`ProjectFormat.Deserialize` / `ProjectFormat.Serialize` in C#. Both validate before
returning a separate copy. Failed imports or edits leave the current document intact

The API must retain its authenticated route/project identity checks, permission
checks, revision protocol and transaction boundaries. Pass only a server-approved
asset registry to validation. Ownership, assignments, permissions, revisions,
credentials and recovery history are not accepted document fields

JSON is data. Serve it as JSON; do not embed raw serialized content into HTML.
Object-property order and equivalent numeric spellings carry no authored meaning

## Runtime capabilities

Storage preserves known variants even when a player cannot execute them. Before
preview or publication, use `missingProjectCapabilities` or
`ProjectCapabilities.Missing` with the capabilities implemented by that player build

Capability names include `multipleScenes`, `visibility`, `content:<type>`,
`audio:spatial`, `audio:global`, `text:<mark>`, `trigger:<type>` and `action:<type>`.
Enabled unsupported rules block execution with field-level diagnostics. Disabling a
rule removes its trigger/action requirements without deleting its saved data

## Checks

Browser cases run with the existing web unit suite. The same fixtures run in C#:

```powershell
dotnet run --project apps/server/project-format-checks/Spatia.ProjectFormat.Checks.csproj -c Release
```

The C# library and checks use the .NET framework libraries without extra packages.
The browser recovery checks also exercise version-2 IndexedDB round trips, recovered
undo/redo and rejection of preview features absent from the current player

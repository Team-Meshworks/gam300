# Stand and display toolbar SVGs

These files are unchanged full-instance SVG exports from the team's
[Figma design](https://www.figma.com/design/QNpdfKb2Ge7vO8uG8HphxB?node-id=152-59981),
exported on 3 November 2026 with the Figma Plugin API (`exportAsync`, `SVG_STRING`).
They retain the source 40 × 40 viewport, internal padding, colour, fill opacity and strokes.
`Icon.tsx` imports them as image assets rather than redrawing or inlining their paths.

| File                            | Source node | Design name               | Runtime asset                     |
| ------------------------------- | ----------- | ------------------------- | --------------------------------- |
| `horizontal-stand.svg`          | `152:60024` | Horizontal Stand          | `display-rectangle-stand-v1`      |
| `vertical-stand.svg`            | `152:60025` | Vertical Stand            | `display-square-stand-v1`         |
| `vertical-panel.svg`            | `152:60026` | Vertical Panel            | `display-square-panel-v1`         |
| `horizontal-panel.svg`          | `152:60027` | Horizontal Panel          | `display-rectangle-panel-v1`      |
| `cube-display-case.svg`         | `152:62226` | Cube Display Case         | `display-cube-v1`                 |
| `clear-cube-display-case.svg`   | `152:62227` | Clear Cube Display Case   | `display-half-glass-case-v1`      |
| `clear-cuboid-display-case.svg` | `152:62228` | Clear Cubiod Display Case | `display-full-glass-case-v1`      |
| `cuboid-display-case.svg`       | `152:62229` | Cubiod Display Case       | `display-one-sided-glass-case-v1` |

The digital tray is node `152:60099` and the physical tray is node `152:62245`.
The Vertical Panel SVG was exported on 4 November 2026. Its supplied GLB is square,
so the runtime label is **Square media panel** while the exact design icon is preserved.

`furniture-bench.svg` is the full `mdi:bench` instance export from Figma node
`168:65016`, exported on 6 November 2026. Both `furniture-modern-bench-1-v1`
and `furniture-modern-bench-2-v1` use this icon in the Furniture toolbar.

`saved-views.svg` is the unchanged 25 × 25 `hugeicons:touch-interaction-04`
export from [Figma node `I187:4469;137:43270`](https://www.figma.com/design/QNpdfKb2Ge7vO8uG8HphxB?node-id=187-4469),
exported on 6 November 2026. The design labels its parent Interactions; the
editor reuses the requested hand icon for Saved views.

The `editor-*.svg` assets are unchanged exports returned by Figma design context
for text `152:62374`, image `152:62291`, video `152:62332`, and physical `160:64163`.
They retain their intrinsic sizes. Reference thumbnail photographs are not included:
the picker uses the real catalogue's model previews and explicitly empty media tabs.

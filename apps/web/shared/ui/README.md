# Shared UI foundation

Reusable primitives for workspace screens live here: `WorkspaceHeader`, `WorkspaceShell`, `Button`, `Field`, `SearchField`, `Tabs`, `Table`, `Avatar`, `Dialog`, and `PageState`, with shared styling in `foundation.css`. The examples exercise these building blocks; they are not integrated product screens.

`WorkspaceHeader` is presentational: pass `account` (`displayName` and optional `role`) and `homeHref`; it never fetches identity. Optional `onHome`, `onSignOut`, `actions`, and `locked` control navigation, logout, extra actions and interaction. A null account shows the signed-out brand only, useful in previews. Shared role styling and grapheme-aware initials are applied here. `WorkspaceShell` accepts the same props in its `header` prop:

```tsx
<WorkspaceShell
  header={{ account: { displayName: "Alex Tan", role: "Creator" }, homeHref: "/home", onSignOut }}
>
  <ProjectList />
</WorkspaceShell>
```

For production pages, the editor's `WorkspaceAccountGate` checks and revalidates the session, handles signed-out, password-change, loading and error states, and supplies the verified session and sign-out action. Pass those values to the header; page-specific navigation and unsaved-work guards still apply. `onHome` can invoke the page's guard before navigating.

`foundation.css` is a workspace entry baseline with global resets and fonts. Do not import it into the existing editor without migrating those styles to an appropriate scope.

From `apps/web`, run `npm run dev` and open `/ui-preview.html` at the Vite server URL. The isolated development entry shows New Project, Submission Review, and Accounts examples with sample data and selectable states. It uses no API, authentication, or storage, and is excluded from the production editor build. With the dev server listening on port 5181, run `npm run test:ui -- http://127.0.0.1:5181/ui-preview.html` for the preview check.

Design references in the Meshworks Figma file: [New Project](https://www.figma.com/design/QNpdfKb2Ge7vO8uG8HphxB/Meshworks?node-id=450-4686), [review](https://www.figma.com/design/QNpdfKb2Ge7vO8uG8HphxB/Meshworks?node-id=232-19739), [class assignment](https://www.figma.com/design/QNpdfKb2Ge7vO8uG8HphxB/Meshworks?node-id=232-19679), and [organisation detail](https://www.figma.com/design/QNpdfKb2Ge7vO8uG8HphxB/Meshworks?node-id=398-2628). These examples are a shared foundation, not complete implementations of those frames. New Project and review use Inter, supplied as static files by Fontsource. Organisation detail uses Satoshi in the design and remains future screen work. The preview examples use Font Awesome; the shared header uses a bundled Iconify landmark. Review preview actions intentionally have no backend.

The ambient artwork in `assets/ambient-left.svg` and `assets/ambient-right.svg` originates from the New Project Figma frame (450:4686).

The administrator variant of `WorkspaceShell` uses `assets/admin-ambient-left.svg` and `assets/admin-ambient-right.svg`, exported from the [Admin – Dashboard frame (226:15002)](https://www.figma.com/design/QNpdfKb2Ge7vO8uG8HphxB/Meshworks?node-id=226-15002). The three directory icons in `editor/admin/assets/` come from that frame as well. SVGs retain their exported dimensions; the dashboard retains the shared Inter typography. Its live data and entry flow are described in `docs/account-directory.md`.

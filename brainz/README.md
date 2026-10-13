# Brainz Whiteboard

Local, persistent BlockSuite canvas embedded in Brainz's macOS WebView.

This directory is the Brainz integration in a fork of BlockSuite. It uses the
published, mutually compatible BlockSuite 0.19.5 packages, pinned in
`package-lock.json`, instead of requiring the entire upstream monorepo build.

```sh
cd brainz
npm ci
npm run dev
npm run build
npm test
```

The native app bundles `dist/`; users need neither Node nor a hosted service.
`window.ipc` connects the page to Brainz for atomic file storage, clipboard,
file picking and opening links. The development preview uses localStorage.
No canvas content is sent to a server.

Boards use a versioned JSON envelope around a Yjs document. Object IDs, text,
connector attachments and linked-file metadata survive reopening. The default
board starts in `Canvases/Untitled.brainzboard` in new workspaces; legacy boards
in `.brainz/whiteboard.brainzboard` still open. The menu beside the name creates
canvases or moves them into sidebar folders. Native `relocated` messages update
the file path used by subsequent saves, AI context and copied links. Deep links
contain that absolute path and an object ID or viewport; they work on a machine
that has the original board. Linked files remain at their original locations.

Connector mode shows outline attachment points at a constant screen size.
Copy PNG in the selection toolbar exports selected objects and their descendants
with even padding, excluding nearby unselected objects. `canvas-overrides.ts`
adapts the pinned engine's connection overlay and transparent-color style cache.

The rail supports single-key tools, repeat locking with Q, and a searchable
command menu (Command-K). Right-click uses the same command registry; ? shows
shortcuts. Sticky notes continue with Tab or Shift-Tab and finish with
Command-Enter. Text sizing defaults to Auto and can be changed in the selection
toolbar. Quick-create dots and the drop picker create attached, editable objects.

`npm ci` applies the reviewed compatibility patches in
`scripts/engine-patches.json`. The installer verifies the exact upstream hashes
before touching package files, keeps originals, and refuses unknown changes.
The patches retain BlockSuite's placement and preview engine while exposing
Brainz creation hooks, keyboard choices, amber snapping, and rounded connectors.
Changing the pinned engine requires reviewing these patches. Vite keys its
dependency cache by the patch contents.

The integration is licensed under MPL-2.0; see the root LICENSE. Dependency
licenses remain with their respective packages.

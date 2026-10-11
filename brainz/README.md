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
board lives in `.brainz/whiteboard.brainzboard` inside the workspace. Deep links
contain that absolute path and an object ID or viewport; they work on a machine
that has the original board. Linked files remain at their original locations.

The integration is licensed under MPL-2.0; see the root LICENSE. Dependency
licenses remain with their respective packages.

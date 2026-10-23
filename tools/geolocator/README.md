# Geolocation Verification Tool

A single-page client-side app for geolocation verification: a rotatable Leaflet map
with several modes (Places search, Ground imagery, Draw, Line-of-Sight, Angles
analysis), a side panel for image upload/annotation, and a shared drawing toolbar.
Projects can be saved to and restored from a versioned JSON file, including image
layers, linked annotations, notes, map drawings, and viewport state.

## Live collaboration

Click **Collaborate** in both browsers. One person chooses **Share my project** and
sends the invite code; the other chooses **Join a project** and sends the reply code.
Compare the displayed verification number through a trusted second channel before
both people confirm it. The host's project then opens in the guest browser, and both
people can edit images, drawings, map shapes, and notes. Map navigation and mode
selection stay personal. Concurrent edits to the same item ask the guest which edit
to keep. Each participant should save a project file at the end.

The app remains static: WebRTC connects the two browsers directly, using a public
STUN lookup and manual codes. Both people must be online. A restricted network may
block direct connections because this app has no TURN relay. The live project limit
is 20 MB, with a 10 MB limit for newly uploaded images during a session. Sessions
support two people and have no automatic persistence or reconnect. Remote edits
clear local Undo history. The invite and reply codes can reveal network addresses;
exchange them through a trusted channel. Shared files are validated and the open
project is backed up before an import replaces it.

**Pure static.** No backend, no build step, no bundler, no framework. Just
`index.html` + `assets/`. All vendor libraries are self-hosted under `assets/vendor/`
(the PeakFinder runtime script is the only external fetch, by design).

## Run / deploy
- **Local testing** — use any plain static server (do **not** use a live-reload
  server such as VS Code "Live Server"; it injects a reload snippet and will reload
  the page on every file change):
  ```bash
  python3 -m http.server 8000    # open http://localhost:8000/
  ```
- **Deploy** — release only a clean, reviewed Git commit, then copy `index.html`,
  `protractor.png`, and the `assets/` folder to your website's web root (or a
  subfolder). Run `npm run release:check` first and configure the hosting headers in
  [docs/production-deployment.md](docs/production-deployment.md).

## API keys (stored in the browser's localStorage, per-origin)
- **Mapbox** token — required for Mapbox 3D Line-of-Sight mode and the elevation
  overlay. Get one at https://account.mapbox.com/access-tokens/.
- **Google Street View Embed API** key — required for the Google Street View
  ground-imagery option.

> ⚠️ Keys live in `localStorage` on whichever browser profile enters them. See
> `docs/security-notes.md`.

## Lint (local dev only; not deployed)
```bash
npm run lint      # node scripts/check-js.js — syntax check every assets/js/*.js
npm run check     # syntax + static production guards
```
This is a zero-dependency guard (just `node --check`). It catches parse-time
regressions like duplicate `const` declarations. It needs no DOM and no server.

## Browser support
Targets modern Chromium/WebKit/Firefox. A one-time notice is shown in Firefox since
some features behave better in Chromium-based browsers.

## Project layout
```
index.html                 UI + inline handlers
assets/css/styles.css      all styles
assets/js/                 classic scripts (drawing-tools.js is the largest)
assets/vendor/             self-hosted libs (Leaflet, Mapbox GL, Konva, Turf, ...)
docs/                      design + security notes
scripts/check-js.js        lint script (npm run lint)
AUDIT-PLAN.md              bug audit + remediation tracker
AGENTS.md                  guidance for AI agents / contributors
```

## Contributing / known issues
See `AUDIT-PLAN.md` for the current bug audit and remediation status, and
`AGENTS.md` for the conventions and commands any contributor (human or AI) should
follow.

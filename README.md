# Crunchy Tools

An all-in-one enhancement extension for [Crunchyroll](https://www.crunchyroll.com)
(Chrome / Edge, Manifest V3):

- **Auto-skip** intro, recap, outro/credits, and the next-episode preview — each
  independently toggleable.
- **Auto-play the next episode** when one finishes.
- **Remember volume** (and mute) across episodes and sessions.
- **Keyboard shortcuts**: `P` Picture-in-Picture · `]` / `[` speed up/down ·
  `\` reset speed · `N` next episode.
- **MyAnimeList sync**: update your MAL progress automatically at ~80% watched
  (opt-in; see setup below).
- A small **"Skipped intro — Undo"** toast so a skip never feels like a glitch.
- A quick-toggle **popup** and a full **options page**, synced across your
  signed-in browsers via `chrome.storage.sync`.

## MyAnimeList sync

**Users** just open Options → **MyAnimeList** → **Connect MyAnimeList**, log into
their own MAL account, and toggle **Sync watched episodes** on. Nothing to
configure. Progress is matched by series name + season; fix a wrong match under
**Series → MyAnimeList mappings**. Each sync shows a confirmation toast.

### Developer setup (one-time, to bake in the API client)

1. At [myanimelist.net/apiconfig](https://myanimelist.net/apiconfig) → **Create
   ID**, set **App Type = Other** (a public client — no secret).
2. Set **App Redirect URL** to exactly:
   `https://jcfmdllkakmjkihgphmmimhiehcbbfei.chromiumapp.org/`
   (This ID is pinned by the `key` in the manifest, so it's stable.)
3. Paste the generated **Client ID** into `src/shared/mal-config.ts`
   (`MAL_CLIENT_ID`) and rebuild.

Auth is OAuth2 authorization-code + PKCE; tokens are stored locally and refreshed
automatically. The client ID is safe to ship (it's not a secret in PKCE flows);
the signing key (`mal-signing-key.pem`) is gitignored.

> This is a personal, client-side enhancement that only automates actions you can
> already perform yourself (clicking *Skip* / *Next*). It does not bypass
> paywalls, DRM, or advertising.

## How skipping works

Crunchyroll publishes per-episode skip timings as static JSON — the same data
that powers its own **Skip Intro** button:

```
https://static.crunchyroll.com/skip-events/production/{episodeId}.json
```

The extension supports two methods (Options → *Skip method*):

- **Smart seek** (default): the background worker fetches that JSON and the
  content script seeks the `<video>` straight past each enabled segment. If an
  episode has no published data, it **falls back to clicking** Crunchyroll's
  native skip button.
- **Click native button**: only ever clicks Crunchyroll's own skip button.

Because Crunchyroll is a single-page app, the content script watches History API
navigation and re-initialises for each new episode without a page reload.

## Project layout

```
src/
├─ manifest.config.ts      # MV3 manifest (consumed by crx() in vite.config.ts)
├─ content/                # everything that runs on the watch page
│  ├─ index.ts             #   entry: wires the pieces together per episode
│  ├─ navigation.ts        #   SPA episode-change detection
│  ├─ player.ts            #   locate <video>, seek helper
│  ├─ skip-api.ts          #   ask the worker for skip-events data
│  ├─ skip-engine.ts       #   seek-mode auto-skip
│  ├─ dom-skip.ts          #   fallback: click the native skip button
│  ├─ autonext.ts          #   auto-play next episode
│  └─ toast.ts             #   "Skipped X — Undo" overlay
├─ background/
│  └─ service-worker.ts    # fetches skip-events JSON (avoids CORS)
├─ options/  popup/        # settings UIs
├─ shared/                 # types, settings store, message contracts, parser
└─ assets/icons/
```

## Build & load

```bash
npm install
npm run build    # type-checks, then esbuild-bundles to dist/
```

The content script is bundled as a single self-contained IIFE (no code-splitting,
no dynamic `import()`) and declared directly in the manifest. This matters:
Crunchyroll's player runs in a cross-origin iframe
(`static.crunchyroll.com/.../player.html`) with a strict CSP, and a
dynamic-import-based content-script loader (e.g. `@crxjs`) gets blocked there — so
the skip code would never run where the video actually is. Manifest-declared
content scripts are injected by Chrome and bypass the page CSP.

Then in Chrome / Edge:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the `dist/` folder.
4. Open any Crunchyroll `/watch/...` episode.

> After each rebuild, click the **reload** ↻ icon on the extension's card in
> `chrome://extensions` so Chrome picks up the new `dist/`, then reload the tab.

Use the toolbar **popup** for quick toggles, or **More settings** for the full
options page.

## Verifying it works

- Open an episode with an intro → it should auto-skip, with a toast.
- **Undo** in the toast restores your position and won't re-skip that segment.
- Let an episode reach the credits → outro skip and (if enabled) auto-next.
- Navigate to another episode **without reloading** → still works (SPA case).
- Toggle settings in the popup → they apply live, no reload needed.
- DevTools console shows the content script's activity; the **service worker**
  (chrome://extensions → *Inspect views: service worker*) shows skip-events
  fetches and any `404`s (normal for episodes with no published data).

## Roadmap

Planned, building on the same architecture: default audio/subtitle/quality
selection, remembered volume, playback-speed and keyboard shortcuts,
Picture-in-Picture, cinema mode, "mark watched", MyAnimeList/AniList sync, and
watch-time stats.

## License

MIT

# Privacy Policy — Crunchyroll Companion

**Effective date:** June 4, 2026

Crunchyroll Companion ("the extension") is a client-side browser extension that
enhances the Crunchyroll viewing experience. This policy explains what data the
extension handles and where it goes.

**Summary:** The extension does not have a backend. It collects no analytics,
shows no ads, and sends nothing to the developer. All of your data stays on your
device or goes directly to the third-party services you choose to connect
(MyAnimeList), exactly as it would if you used those services yourself.

## What the extension stores

All of the following is stored **on your own device** using the browser's
extension storage. None of it is transmitted to the developer.

- **Settings** — your skip toggles, skip method, and playback preferences. These
  are saved with `chrome.storage.sync`, which means Chrome/Edge syncs them across
  browsers where you are signed in to the same browser profile. This sync is
  handled by your browser vendor (Google/Microsoft), not by the extension.
- **Continue-watching history** — a local list of Crunchyroll episodes you have
  recently opened (series title, season/episode, thumbnail URL, and timestamps),
  used to power the Resume and Continue-watching cards. Stored locally; you can
  remove individual entries or clear the whole list at any time from the panel.
- **Skip statistics** — local counters of how much time auto-skip has saved and a
  per-day activity count, used for the stats shown on the home dashboard. Stored
  locally; no event-level browsing data leaves your device.
- **MyAnimeList authentication tokens** — if you connect MyAnimeList, the OAuth
  access/refresh tokens are stored locally and used only to talk to MyAnimeList
  on your behalf. They are never sent anywhere else.

## Network requests the extension makes

- **Crunchyroll** (`crunchyroll.com`, `static.crunchyroll.com`) — reads the
  current page's episode metadata and fetches Crunchyroll's own public
  per-episode skip-timing JSON to know where intros/recaps/credits are.
- **MyAnimeList** (`myanimelist.net`, `api.myanimelist.net`) — **only if you opt
  in** by connecting your account. Used to read and update your anime list
  (episode progress, status, score) at your request or, with auto-sync enabled,
  to advance your progress to the episode you are watching. Progress is only ever
  moved forward.
- **Jikan** (`api.jikan.moe`) — an unofficial, read-only MyAnimeList data API
  used to fetch public show details (characters, reviews, and seasonal/trending
  anime). These requests send only public anime identifiers and search terms.
  They contain **no personal information** and no MyAnimeList account data.

## What the extension does NOT do

- It does not collect analytics or telemetry.
- It does not contain any tracking, advertising, or fingerprinting code.
- It does not sell or share your data with anyone.
- It does not transmit any data to the developer or to any server the developer
  controls (the extension has no backend).
- It does not bypass paywalls, DRM, or advertising. It only automates actions you
  can already perform yourself (clicking *Skip* / *Next*).

## Permissions

- **storage** — to save your settings, history, and stats as described above.
- **identity** — to perform the MyAnimeList OAuth login flow in a secure browser
  window (only used when you connect your account).
- **sidePanel** — to display the companion UI in the browser side panel.
- **Host access** to Crunchyroll, MyAnimeList, and Jikan — to make the requests
  described in "Network requests" above. The extension does not access any other
  sites.

## Data retention and deletion

All stored data lives on your device. You can delete it at any time by clearing
items in the panel, disconnecting MyAnimeList (which removes stored tokens), or
removing the extension, which deletes all of its local and synced storage.

## Third-party services

Connecting MyAnimeList means your interactions with it are subject to
MyAnimeList's own privacy policy. Public show details are retrieved via the Jikan
API; see its terms at https://jikan.moe. The developer is not affiliated with
Crunchyroll, MyAnimeList, or Jikan.

## Changes

This policy may be updated as the extension evolves; the effective date above
will be revised accordingly.

## Contact

Questions about this policy: dell@donatoni.dev

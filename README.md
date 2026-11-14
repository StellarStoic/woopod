# woopod public website

Static, buildless project homepage and current-feature documentation for GitHub Pages. The homepage makes no external font, analytics, advertising, image or JavaScript request. Player pages load the selected publisher’s audio/artwork and request feed metadata from the same-origin resolver.

Android 0.17.3 adds a Subscribe/Subscribed row in the Player menu and a Subscribe/Unsubscribe action in the Playlist hold menu. Older queued episodes can recover their publisher feed when subscribing. New subscriptions appear at the top of Library as soon as they are saved. Unsubscribe asks for confirmation and keeps the playback queue.

Android 0.18.0 expands comments to 99% of the safe screen area, adds Comments to podcast pages, and uses pull-down feed refresh there. Public authors show verified profile records; profile/note references open in-app previews. A shared renderer handles clickable public references and HTTP/HTTPS links across the app, retaining HTML anchor destinations in descriptions. These Android changes do not change the local website player's rendering behavior.

Android 0.18.1 applies the same 99% reading window to Episode details, with full-width show notes and chapters plus a back-to-top control.

Android 0.18.2 adds Skip silence directly below playback speed in the Player menu, sharing the saved You → Audio setting.

Android 0.18.3 separates progress-bar gestures: drag the position dot without holding, tap to seek on release, or swipe elsewhere on the track to change pages. Cancelled gestures do not seek.

Android 0.19.0 opens Library from small local podcast headers and accurate counts, with episode archives loading in the background. Opening a podcast loads its own list directly. Header-only metadata saves retain stored episodes.

Android 0.19.1 lets the listener tap the podcast name under Now playing to open its Library page. For a show outside Library, it opens the existing feed preview without subscribing automatically.

Android 0.19.2 scrolls long podcast names in Player using the existing Title scroll speed setting; 0 disables movement and the name remains tappable.

## Preview locally

From this directory:

```sh
python3 -m http.server 8080
```

Open `http://localhost:8080/`.

## Publish with GitHub Pages

Use this directory as the root of a **separate public repository**. In GitHub, open **Settings → Pages**, select **Deploy from a branch**, choose the default branch and `/ (root)`. The `.nojekyll` file prevents Jekyll processing.

Do not copy Android source, private build inputs, signing material, device logs or internal development documents into the public website repository. Copy only explicitly approved screenshots, release APK links, public documentation and brand assets.

## Content status

The page distinguishes **Available**, **Partial**, and **Roadmap** capabilities. Update those labels alongside public app releases. The current page describes the Android `0.17.0-preview` implementation and its recorded roadmap; it does not provide an APK download or claim a production release.

## Files

- `index.html` — semantic page content, documentation and inline SVG icon sprite
- `styles.css` — responsive presentation and reduced-motion behavior
- `app.js` — parallax, reveal, navigation, documentation search, color and font demos
- `assets/` — supplied woopod brand images
- `manifest.webmanifest`, favicon files and `.nojekyll` — browser/GitHub Pages metadata

## Local player preview (unpublished)

From the Android workspace root, run:

```sh
python3 tools/web-preview/serve.py --port 8765
```

Then open:

- `http://localhost:8765/c/?demo=1` — 15–45 second clip of an original sound sample
- `http://localhost:8765/p/?demo=1` — the complete 90-second sound sample

`c/index.html` and `p/index.html` share `player/` assets. No account, relay connection, analytics or publication occurs on playback. Clip comments are public text decoded from the link; they are not Nostr events. The preview sample is original synthesized audio, not a recording of a real podcast.

Player pages open from their shared URL; there is no URL-entry form. For local testing of an app link, replace `https://woopod.com/c` with `http://localhost:8765/c/`, retaining its query. Direct public HTTPS audio links use `/p/?audio=<encoded audio URL>` without the resolver. Both players expose playback speed as a visible slider and adapt their layout to the viewport without page scrolling. Long clip notes get their own thin scrollbar only when needed, with a readable minimum 16 px font. The local server binds loopback, validates public HTTPS destinations and redirects, supports RSS/Atom/XML-base and byte-range sample playback, and limits feed fetches to 8 MB. It is a development adapter, not a deployable backend or archive snapshot store.

The static site can play direct audio without an API, provided the publisher and browser support it. Feed-based links require a same-origin `api/v1/clip` resolver. GitHub Pages cannot run this Python server. Production resolver response integration, snapshots and public chat are separate work; this local preview does not claim them. Android 0.17 emits full-episode `/p/` links, including a direct-audio fallback when publisher identity is unavailable. The static routes are live on woopod.com; production feed resolver integration is pending.

The user approved publishing the website. Future changes must preserve changes made by other agents.

Public conversation code uses bundled signature verification, public relay reads and explicit browser-signer approval. See workspace docs/PUBLIC-SOCIAL.md and docs/APP-WEB-PUBLIC-SOCIAL-HANDOFF.md for protocol, local admission and production requirements. Rebuild the bundle with `npm ci --prefix tools/web-social --ignore-scripts` and `npm run --prefix tools/web-social build` from the Android workspace; no build is required to serve the generated static files.

Android 0.19.3 replaces the Bitcoin icon with V4V. The large support window visually separates payment-service links, other URLs and crypto destinations without group headings, preserving publisher labels and routing information.

Android 0.19.4 places buffering feedback in the Player timeline’s space and restores the seek bar when buffering ends.

Android 0.19.5 highlights the entire selected bottom-menu item with a rectangular theme-colored background.

Android 0.19.6 lets listeners choose Library, Playlist, Player, Discover or You as the default startup menu in You → Settings. It follows destination names when the bottom menus are reordered.

The browser player does not need Google services, Google Play or an installed app. A missing feed or unavailable resolver produces a readable error with a retry and an original-feed link.

Podcast pages use `/show?f=<encoded HTTPS feed>` and the same-origin `/api/v1/show` resolver; see the workspace `docs/WEB-PLAYER.md` for the required API response and production handoff.

The source supports paginated podcast episode lists (`offset`, `total`, `nextOffset`), rejects feeds above 8 MB rather than returning a partial feed, and supplies podcast-page social cards. These are live: the `woopod-share` Worker serves `woopod.com/p*`, `woopod.com/c*`, `woopod.com/show*` and `woopod.com/api/*` through Cloudflare routes, so share cards and the resolvers answer per link. A GitHub push alone still only publishes static assets — server changes need the Worker rebundled and redeployed.

## Android App Links

`woopod.com` opens links inside the app only when the site vouches for the app: Android fetches
`https://woopod.com/.well-known/assetlinks.json` and compares the certificate the installed APK is
signed with against the fingerprints listed there. The manifest declares `woopod.com` with
`android:autoVerify="true"` for `/show`, `/p` and `/c`.

The published file names the package **`dev.woopod`** and one fingerprint: the **debug** signing
certificate, so a locally built test APK verifies today.

    # regenerate after any change (normalises the fingerprint and writes the file)
    python3 woopod_assetlinks.py emit --package dev.woopod --sha256 <SHA-256> --out .well-known/assetlinks.json
    # then prove the live address the way Android reads it: 200, no redirect, application/json, values present
    python3 woopod_assetlinks.py verify --package dev.woopod --sha256 <SHA-256>

**When the release key exists**, replace the debug fingerprint rather than adding to it: Play re-signs
uploads, so the fingerprint that matters is the *app signing key* certificate from Play Console →
App integrity. Keep the debug fingerprint only while debug builds are being tested, and remove it
before release — a published association is a statement that any APK signed with that certificate is
woopod. `adb shell pm verify-app-links --re-verify dev.woopod` re-checks on the device, and
`adb shell pm get-app-links dev.woopod` reports the state.

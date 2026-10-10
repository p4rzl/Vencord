# PlexRichPresence

Shows your Plex music playback on Discord with album artwork, progress and an optional React playback widget.
Requires desktop Vencord and permission to read the shared/owned music library.

## Setup

1. Enable the plugin and **Log in with Plex**. Approve the official browser flow; no Plex password is requested.
2. If needed, **Choose Plex Home Profile**. Protected profiles require their PIN again after restarting; PINs are not saved.
3. **Choose Plex Server Resource** to select an owned or shared server.
4. Optionally **Choose Plex Player** to follow a specific device. Automatic mode prefers a playing session belonging to your selected identity.
5. Enable activity sharing in Discord's Activity Privacy settings. Restart Discord after installing this version so the account-panel patch can load.

Profile, server and player selection use Discord modals, not unsupported Electron `window.prompt()` dialogs. Cancel/escape leaves the current choice unchanged. Plex Home PINs are entered in a masked field and are never saved. The controller supports current and legacy Discord theme variables for readable dark/light colors.

The default Discord Application ID is the public Plex RPC application used by
[discord-rich-presence-plex](https://github.com/phin05/discord-rich-presence-plex/blob/master/server/config/default.go).
You can override it with your own application ID (not a bot token).

## Shared servers and remote playback

- Discovery retains **all** advertised connections, including remote HTTPS and relay. It checks reachability and remembers a working connection, rather than assuming the local address is reachable.
- Server calls use the resource's access token, which can differ from the account token.
- Session detection never substitutes the server owner's identity for your selected profile.
- If `/status/sessions` is unavailable, the plugin polls your selected profile's own discovered Plex Companion players at `/player/timeline/poll`, then reads the track's library metadata using the shared server token.
- It also checks Plexamp's local endpoint at `http://127.0.0.1:32500/resources` without credentials and adds that connection **only if its identifier matches an owned player discovered for the selected profile**. The optional Companion URL can be changed to a trusted reachable endpoint or cleared to disable this probe. Unknown players are never attached automatically.
- This fallback is conditional: the player must advertise a reachable Companion endpoint, expose a music timeline, and be playing from the selected server. Plexamp versions/platforms may not provide this interface. A phone on another network is **not** made reachable by the server's relay.
- Remote server playback works when the server advertises a reachable direct/relay connection and permits sessions, or a reachable player can provide the timeline. There is no permission bypass or cloud-timeline guarantee.

Controls use the actual player's endpoint, not an assumed server proxy. Each button is enabled only if the observed timeline advertises its capability. Shuffle/repeat state is read from the player; repeat cycles off → all → one. Presence can work without controls.

## Artwork and privacy

- The widget can display the exact private Plex image, downloaded in the native process with the token in a header.
- Discord artwork comes **only from public iTunes/Deezer catalogs**. Artist and album (or track when album is absent) must match; unmatched albums use a generic Plex icon.
- Enabling artwork sends artist/album search metadata to these catalogs. Disable **Show album art** to disable artwork downloads and catalog lookups.
- Private Plex images are **never uploaded**. No Plex token, private URL or data URL is sent as a Discord image asset. The previous temporary-host uploader has been removed.
- External images are registered through Discord's asset lookup. No media-proxy IDs are fabricated. Covers visible locally are not proof that another Discord account can see the published asset.
- Tokens remain in local Vencord settings, as in earlier versions; hidden settings are not encrypted storage. Do not share settings exports containing credentials.

## Reliability and diagnostics

Polling has bounded network/body timeouts, response-size limits and expiring caches. Network/HTTP failures retain the login; a confirmed account-token rejection requires a new login. Missing profiles/servers do not silently switch to the owner or a different saved server. Paused tracks do not have advancing Discord timestamps. Logout, profile changes and plugin shutdown invalidate in-flight presence updates.

**Show diagnostics** reports the latest stage/error, HTTP status, playback source, connection type and whether controls/public artwork are available. It omits credentials, addresses, profile names and track titles. When reporting a failure, include this output, Plexamp platform/version and whether Discord and Plexamp are on the same device/network.

Existing token, server and profile settings are retained. Legacy URLs are matched to discovered resources by connection or server identifier.

## Verification

```sh
pnpm testPlexRichPresence
pnpm testTsc
pnpm exec eslint src/plugins/PlexRichPresence
pnpm exec stylelint src/plugins/PlexRichPresence/style.css
pnpm build
```

The visual contrast/layout tests run when Chromium is installed at a standard system location or `PLEX_TEST_BROWSER` points to a Chromium executable; otherwise only these browser tests are skipped.

Before relying on it, test a real shared account and Plex Home profile, switch from LAN to an external network, pause/seek/change tracks, and view the presence from **another Discord account**. Automated fixtures do not establish which permissions or Companion features your Plex installation exposes.

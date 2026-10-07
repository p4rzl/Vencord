# PlexRichPresence

A Vencord plugin that shows your active **Plex** music playback in Discord status (Spotify-style), with optional playback controls.

## What changed

This plugin now uses Plex account/resource discovery instead of requiring a manually typed server URL.

- Uses official Plex PIN login in browser (`Log in with Plex`)
- Never asks for your Plex password
- Discovers accessible Plex servers/resources from Plex account APIs
- Lets you choose the resource when multiple servers are available
- Supports Plex Home profile selection (including managed users)
- Keeps session identity tied to the selected/current Plex user (not silently server owner)

## Setup

1. Open plugin settings and click **Log in with Plex**.
2. Complete Plex auth in browser (or use `plex.tv/link` with the shown code).
3. Optional: click **Choose Plex Home Profile** and select your managed/shared profile.
4. Click **Choose Plex Server Resource** if multiple resources are available.

The resource list includes useful labels:

- Server/resource name
- Owner (`You` or shared owner)
- Connection type (`Local direct`, `Remote direct`, or `Relay`)
- Selected URI

The plugin prefers a valid local/direct connection automatically, but remote/shared resources are supported.

## Plex Home behavior

- Managed users may require a Plex Home PIN when switching profile.
- PIN is prompted only during switch and is never stored.
- If Plex denies switch/token exchange, plugin shows an explicit error and does not impersonate the owner profile.

## Permissions and limitations

- Rich Presence requires read access to `/status/sessions` on the selected resource.
- Playback controls are automatically disabled when control permission is not available.
- Rich Presence can still work when controls are disabled.

## Troubleshooting

- **No resources found**: ask server owner to share the server with your Plex account/profile.
- **`/status/sessions` denied**: choose another resource or request session access from owner.
- **Auth expired/unauthorized**: log out and log in again.
- **Resource changed/removed**: re-open settings and select a resource again.

## Legacy migration

Older `serverUrl` / `plexToken` settings are handled for compatibility:

- existing Plex token is reused as account login when possible
- legacy server URL is used only to migrate to a discovered resource
- manual server URL setup is deprecated for normal usage

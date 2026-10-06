# PlexRichPresence

A Vencord plugin that displays your active **Plex Media Server** or **Plexamp** music playback directly in your Discord status, styled like Spotify (*"Listening to Plex"*).

## Features

- **Secure Login (Plex OAuth)**: Authenticates via Plex PIN OAuth without storing your password.
- **Plex Home support**: Works with standard Plex accounts and Plex Home profiles (including managed users) through Plex Home user switching.
- **Automatic Album Art**: Fetches cover art automatically via the **MusicBrainz API** (Cover Art Archive) and **iTunes Search API**, with local server fallback and a generic Plex icon as a backup.
- **Spotify Style**: Displays track title, artist, album, cover art, and real-time playback progress.

## Setup

1. Set `Plex Media Server address` (for example `http://192.168.1.10:32400`).
2. Click `Log in with Plex` and complete the browser flow.
3. If you use Plex Home, click `Choose Plex Home Profile` and select the correct profile.
4. For PIN-protected managed profiles, enter the Plex Home PIN when prompted (the PIN is not stored).

## Plex Home notes and limitations

- This plugin does **not** accept pasted owner/server tokens as a workaround.
- After a Plex Home switch, the plugin resolves a server-scoped token from Plex resources for the selected profile.
- If Plex does not provide server access for that selected profile, playback polling cannot continue until that profile is shared on the server (or another profile is selected).

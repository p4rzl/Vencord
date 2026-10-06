/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * PlexRichPresence — Vencord plugin
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ApplicationAssetUtils,Button, FluxDispatcher, Forms, Toasts } from "@webpack/common";

import { mountWidget, unmountWidget, updateWidget, WidgetState } from "./widget";

let pollTimer: ReturnType<typeof setInterval> | null = null;
let loginPollActive = false;
let currentToken: string | null = null;
let plexAccountToken: string | null = null;
let plexAccountUsername: string | null = null;
let lastRatingKey: string | null = null;
let currentPlayerMachineId: string | null = null;
let lastKnownPlaying = false;
let localShuffle = false;
let localRepeat = false;
let tickInFlight = false;
let commandInFlight = false;

interface CachedArt {
    assetId: string | undefined;
    artUrl: string | null;
    dataUrl: string | null;
}

const artAssetCache = new Map<string, CachedArt>();
const ART_CACHE_LIMIT = 200;

const FALLBACK_ART_URL = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/plex.png";

function native() {
    return (window as any).VencordNative.pluginHelpers.PlexRichPresence;
}

function toast(message: string, type: "MESSAGE" | "SUCCESS" | "FAILURE" = "MESSAGE") {
    const toastApi = Toasts as any;
    toastApi.show({
        id: toastApi.genId(),
        type: toastApi.Type[type],
        message
    });
}

async function sendCommand(command: string, params?: Record<string, string>) {
    if (commandInFlight || !currentToken || !currentPlayerMachineId || !settings.store.serverUrl) return;

    commandInFlight = true;
    try {
        const result = await native()
            .sendPlayerCommand(settings.store.serverUrl, currentToken, currentPlayerMachineId, command, params ?? {})
            .catch((e: any) => ({ ok: false, error: String(e) }));

        if (!result?.ok) {
            console.error("[PlexRichPresence] Command failed:", command, result?.error);
            toast(`Plex command failed: ${command}`, "FAILURE");
            return;
        }

        // Plex updates its session asynchronously. Re-poll shortly after a
        // command so the widget/RPC reflect the real player state.
        setTimeout(() => void tick(), 500);
    } finally {
        commandInFlight = false;
    }
}

const widgetCallbacks = {
    onPlayPause: () => sendCommand(lastKnownPlaying ? "pause" : "play"),
    onNext: () => sendCommand("skipNext"),
    onPrevious: () => sendCommand("skipPrevious"),
    onShuffleToggle: () => {
        localShuffle = !localShuffle;
        sendCommand("setParameters", { shuffle: localShuffle ? "1" : "0" });
    },
    onRepeatToggle: () => {
        localRepeat = !localRepeat;
        sendCommand("setParameters", { repeat: localRepeat ? "1" : "0" });
    },
    onSeek: (offsetMs: number) => sendCommand("seekTo", { offset: String(Math.round(offsetMs)) })
};

function formatExternalAsset(url: string): string | undefined {
    if (!url) return undefined;
    if (url.startsWith("mp:")) return url;
    if (!/^https?:\/\//i.test(url)) return undefined;

    // Discord's local activity layer expects media-proxy assets in mp: form.
    // Discord converts the external URL to its media proxy internally.
    return `mp:external/${url.replace(/^https?:\/\//i, "https/")}`;
}

async function registerAsset(applicationId: string, publicImageUrl: string): Promise<string | undefined> {
    if (!publicImageUrl || publicImageUrl.startsWith("data:")) return undefined;

    if (ApplicationAssetUtils?.fetchAssetIds && applicationId) {
        try {
            const [assetId] = await ApplicationAssetUtils.fetchAssetIds(applicationId, [publicImageUrl]);
            if (assetId) return assetId;
        } catch (e) {
            console.warn("[PlexRichPresence] Discord asset lookup failed, falling back to media proxy:", e);
        }
    }

    return formatExternalAsset(publicImageUrl);
}

async function pollPin(id: number): Promise<string | null> {
    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const token = await native().checkPin(id).catch(() => null);
        if (token) return token;
    }
    return null;
}

function resetStoredAuth() {
    settings.store.plexToken = "";
    settings.store.homeUserTitle = "";
}

function resetRuntimeAuth() {
    currentToken = null;
    plexAccountToken = null;
    plexAccountUsername = null;
}

async function pickHomeUser() {
    if (!plexAccountToken) {
        toast("Log in with Plex first, then pick a Plex Home user.", "FAILURE");
        return;
    }

    const users = await native().fetchHomeUsers(plexAccountToken).catch(() => []);
    if (!users?.length) {
        toast("No Plex Home profiles were found for this account.", "FAILURE");
        return;
    }

    const optionsText = users.map((u: any, i: number) => {
        const role = u?.restricted ? "managed" : "full";
        const pin = u?.protected ? ", PIN protected" : "";
        return `${i + 1}. ${u?.title ?? "Unknown"} (${role}${pin})`;
    }).join("\n");

    const response = window.prompt(
        "Choose the Plex Home profile number for Rich Presence.\n" +
        `Leave blank to use the account profile.\n\n${optionsText}`,
        settings.store.homeUserTitle ? String(users.findIndex((u: any) => u?.title === settings.store.homeUserTitle) + 1) : ""
    );

    if (response === null) return;

    const rawValue = response.trim();
    if (!rawValue) {
        settings.store.homeUserTitle = "";
        toast("Using the main Plex account profile.", "SUCCESS");
        await refreshAuthForServer();
        void tick();
        return;
    }

    const selectedIndex = Number(rawValue);
    if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > users.length) {
        toast("Invalid selection. Use one of the listed profile numbers.", "FAILURE");
        return;
    }

    const selected = users[selectedIndex - 1];
    settings.store.homeUserTitle = selected.title ?? "";
    toast(`Selected Plex Home profile: ${selected.title}`, "SUCCESS");
    await refreshAuthForServer();
    void tick();
}

async function refreshAuthForServer(): Promise<boolean> {
    if (!plexAccountToken || !settings.store.serverUrl) {
        currentToken = null;
        return false;
    }

    let effectiveToken = plexAccountToken;
    let effectiveUsername = await native().fetchUsername(plexAccountToken).catch(() => null);

    const selectedHomeUserTitle = settings.store.homeUserTitle?.trim();
    if (selectedHomeUserTitle) {
        const users = await native().fetchHomeUsers(plexAccountToken).catch(() => []);
        const selectedUser = users.find((u: any) => u?.title?.toLowerCase() === selectedHomeUserTitle.toLowerCase());

        if (!selectedUser) {
            toast(`Plex Home profile "${selectedHomeUserTitle}" was not found. Pick another profile.`, "FAILURE");
            currentToken = null;
            return false;
        }

        let pin: string | undefined;
        if (selectedUser.protected) {
            const enteredPin = window.prompt(`Enter Plex Home PIN for "${selectedUser.title}"`, "");
            if (enteredPin === null) {
                toast("Plex Home switch canceled.", "MESSAGE");
                currentToken = null;
                return false;
            }
            pin = enteredPin.trim() || undefined;
        }

        const switched = await native().switchHomeUser(plexAccountToken, selectedUser.id, pin).catch(() => null);
        if (!switched?.token) {
            const reason = switched?.needsPin
                ? "This Plex Home profile requires a valid PIN. Please try again."
                : "Plex did not allow switching to this profile.";
            toast(`${reason} Rich Presence cannot continue with this profile.`, "FAILURE");
            currentToken = null;
            return false;
        }

        effectiveToken = switched.token;
        effectiveUsername = selectedUser.title ?? effectiveUsername;
    }

    const machineIdentifier = await native().fetchServerMachineIdentifier(settings.store.serverUrl, effectiveToken).catch(() => null);
    if (machineIdentifier) {
        const serverAccessToken = await native().resolveServerAccessToken(effectiveToken, machineIdentifier).catch(() => null);
        if (serverAccessToken) {
            effectiveToken = serverAccessToken;
        } else if (selectedHomeUserTitle) {
            toast(
                "Plex did not provide a server-scoped token for this Plex Home profile. " +
                "Ask the server owner to share access with this profile, then re-select it here.",
                "FAILURE"
            );
            currentToken = null;
            return false;
        }
    } else if (selectedHomeUserTitle) {
        toast("Could not verify this Plex server for the selected Plex Home profile.", "FAILURE");
        currentToken = null;
        return false;
    }

    currentToken = effectiveToken;
    plexAccountUsername = effectiveUsername;
    return true;
}

async function startPlexLogin() {
    if (loginPollActive) {
        toast("Login already in progress, check your browser.", "MESSAGE");
        return;
    }

    const pin = await native().requestPin().catch(() => null);
    if (!pin) {
        toast("Couldn't reach Plex to generate the login code.", "FAILURE");
        return;
    }

    const authUrl =
    "https://app.plex.tv/auth#?clientID=vencord-plex-rich-presence" +
    `&code=${pin.code}` +
    "&context%5Bdevice%5D%5Bproduct%5D=Vencord%20Plex%20Rich%20Presence";

    window.open(authUrl, "_blank");

    toast(
        `A browser tab opened to link your Plex account. If it didn't open, go to plex.tv/link and enter the code: ${pin.code}`,
        "MESSAGE"
    );

    loginPollActive = true;
    const token = await pollPin(pin.id);
    loginPollActive = false;

    if (!token) {
        toast("Timed out: the code was not confirmed in time.", "FAILURE");
        return;
    }

    settings.store.plexToken = token;
    plexAccountToken = token;
    currentToken = null;
    artAssetCache.clear();
    const linked = await refreshAuthForServer();
    toast(
        linked
            ? "Plex account linked successfully!"
            : "Plex account linked. Select a valid Plex Home profile/server access to continue.",
        linked ? "SUCCESS" : "MESSAGE"
    );
    tick();
}

const settings = definePluginSettings({
    loginButton: {
        type: OptionType.COMPONENT,
        description: "Link your Plex account/home (opens browser, no password typed in Vencord)",
                                      component: () => (
                                          <Button onClick={() => startPlexLogin()}>
                                          Log in with Plex
                                          </Button>
                                      )
    },
    logoutButton: {
        type: OptionType.COMPONENT,
        description: "Clear the Plex account token and selected Plex Home profile",
                                      component: () => (
                                         <Button
                                             color={Button.Colors.RED}
                                             onClick={() => {
                                                 resetStoredAuth();
                                                 resetRuntimeAuth();
                                                 clearActivity();
                                                 updateWidget(null);
                                                 toast("Plex login cleared.", "SUCCESS");
                                             }}
                                         >
                                             Log out from Plex
                                         </Button>
                                      )
    },
    homeUserButton: {
        type: OptionType.COMPONENT,
        description: "Pick which Plex Home profile this plugin should use",
                                      component: () => (
                                         <Button onClick={() => void pickHomeUser()}>
                                             Choose Plex Home Profile
                                         </Button>
                                      )
    },
    plexToken: {
        type: OptionType.STRING,
        description: "Plex account token (filled automatically; don't paste another user's token)",
                                      default: ""
    },
    homeUserTitle: {
        type: OptionType.STRING,
        description: "Optional Plex Home profile title (managed user). Leave empty to use your account profile.",
        default: ""
    },
    serverUrl: {
        type: OptionType.STRING,
        description: "Your Plex Media Server address (e.g. http://192.168.1.10:32400)",
                                      default: ""
    },
    pollInterval: {
        type: OptionType.NUMBER,
        description: "Polling interval in seconds (minimum 5)",
                                      default: 15
    },
    showAlbumArt: {
        type: OptionType.BOOLEAN,
        description: "Show album cover in Rich Presence using iTunes/Deezer API",
                                      default: true
    },
    applicationId: {
        type: OptionType.STRING,
        description: "Discord Application ID (Optional)",
                                      default: ""
    },
    showControlWidget: {
        type: OptionType.BOOLEAN,
        description: "Show playback controls panel above user profile",
                                      default: true
    }
});

async function resolveAlbumArt(track: any): Promise<CachedArt> {
    const appId = settings.store.applicationId?.trim() || "";
    const artist = track.grandparentTitle ?? track.originalTitle ?? "";
    const album = track.parentTitle ?? "";
    const title = track.title ?? "";
    const thumb = track.thumb || track.parentThumb || track.grandparentThumb;

    const cacheKey = `${appId}:${artist}:${album}:${title}:${track.ratingKey || thumb}`;

    if (artAssetCache.has(cacheKey)) {
        return artAssetCache.get(cacheKey)!;
    }

    let localPlexUrl: string | null = null;
    if (thumb && currentToken && settings.store.serverUrl) {
        const baseUrl = settings.store.serverUrl.replace(/\/$/, "");
        localPlexUrl = `${baseUrl}${thumb}?X-Plex-Token=${encodeURIComponent(currentToken)}`;
    }

    const coverResult = await native().fetchOnlineCover(artist, album, title, localPlexUrl).catch(() => null);
    const publicUrl = coverResult?.artUrl ?? null;
    const dataUrl = coverResult?.dataUrl ?? null;

    const assetId = publicUrl ? await registerAsset(appId, publicUrl) : undefined;

    let result: CachedArt = { assetId, artUrl: publicUrl, dataUrl };

    if (!assetId && settings.store.showAlbumArt) {
        const fallbackAssetId = await registerAsset(appId, FALLBACK_ART_URL);
        result = { assetId: fallbackAssetId, artUrl: FALLBACK_ART_URL, dataUrl: FALLBACK_ART_URL };
    }

    if (artAssetCache.size >= ART_CACHE_LIMIT) {
        const oldestKey = artAssetCache.keys().next().value as string | undefined;
        if (oldestKey) artAssetCache.delete(oldestKey);
    }

    artAssetCache.set(cacheKey, result);
    return result;
}

async function buildActivity(track: any) {
    const artist = track.grandparentTitle ?? track.originalTitle ?? "Unknown artist";
    const album = track.parentTitle ?? "";
    const title = track.title ?? "Unknown track";
    const durationMs: number = track.duration ?? 0;
    const offsetMs: number = track.viewOffset ?? 0;
    const now = Date.now();

    const appId = settings.store.applicationId?.trim() || undefined;
    const { assetId, artUrl, dataUrl } = await resolveAlbumArt(track);

    const activity: any = {
        name: "Plex",
        type: assetId ? 2 : 0,
        ...(appId ? { application_id: appId } : {}),
        details: title,
        state: artist,
        flags: 1 << 0,
        timestamps: durationMs
        ? { start: now - offsetMs, end: now - offsetMs + durationMs }
        : undefined
    };

    if (assetId) {
        activity.assets = {
            large_image: assetId,
            large_text: album || undefined
        };
    }

    return { activity, widgetArtUrl: dataUrl || artUrl };
}

function setActivity(activity: any) {
    FluxDispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity,
        socketId: "PlexRichPresence"
    });
}

function clearActivity() {
    FluxDispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity: null,
        socketId: "PlexRichPresence"
    });
}

async function tick() {
    if (tickInFlight || !settings.store.serverUrl) return;
    if (!currentToken && plexAccountToken) {
        const refreshed = await refreshAuthForServer();
        if (!refreshed) return;
    }
    if (!currentToken) return;

    tickInFlight = true;
    try {
        const result = await native().fetchSessions(settings.store.serverUrl, currentToken).catch(e => {
            console.error("[PlexRichPresence] fetchSessions failed:", e);
            return null;
        });

        if (!result || result.unauthorized || !result.sessions) {
            if (result?.unauthorized) {
                clearActivity();
                lastRatingKey = null;
                currentPlayerMachineId = null;
                updateWidget(null);
                resetStoredAuth();
                resetRuntimeAuth();
                toast("Plex authorization is no longer valid. Please log in again.", "FAILURE");
            }
            return;
        }

    const usernameLower = plexAccountUsername?.toLowerCase();
    const mySession = result.sessions.find((s: any) => {
        if (s.type !== "track") return false;
        const sessionUser = s.User?.title?.toLowerCase();
        return !sessionUser || !usernameLower || sessionUser === usernameLower;
    });

    if (!mySession) {
        if (lastRatingKey !== null) {
            clearActivity();
            lastRatingKey = null;
        }
        currentPlayerMachineId = null;
        if (settings.store.showControlWidget) updateWidget(null);
        return;
    }

    const { activity, widgetArtUrl } = await buildActivity(mySession);
    setActivity(activity);
    lastRatingKey = mySession.ratingKey;

        currentPlayerMachineId = mySession.Player?.machineIdentifier ?? null;
        lastKnownPlaying = mySession.Player?.state === "playing";
        if (typeof mySession.Player?.shuffle === "boolean") localShuffle = mySession.Player.shuffle;
        if (typeof mySession.Player?.repeat === "boolean") localRepeat = mySession.Player.repeat;

    if (settings.store.showControlWidget) {
        const widgetState: WidgetState = {
            title: mySession.title ?? "Unknown track",
            artist: mySession.grandparentTitle ?? mySession.originalTitle ?? "Unknown artist",
            album: mySession.parentTitle ?? "",
            artUrl: widgetArtUrl,
            durationMs: mySession.duration ?? 0,
            offsetMs: mySession.viewOffset ?? 0,
            playing: lastKnownPlaying,
            shuffle: localShuffle,
            repeat: localRepeat,
            timestamp: Date.now()
        };
            updateWidget(widgetState);
        }
    } finally {
        tickInFlight = false;
    }
}

export default definePlugin({
    name: "PlexRichPresence",
    description: "Shows what you're listening to on Plex in Discord, Spotify-style.",
    authors: [{ name: "p4rzl", id: 547438743284482050n }],
    settings,

    settingsAboutComponent: () => (
        <>
        <Forms.FormTitle tag="h3">Setup</Forms.FormTitle>
        <Forms.FormText>
        1. Set 'Plex Media Server address' below (e.g. http://192.168.1.10:32400).{"\n"}
        2. Press 'Log in with Plex' and confirm in the browser tab.{"\n"}
        3. If you use Plex Home, press 'Choose Plex Home Profile' and select your profile.{"\n"}
        4. For PIN-protected managed profiles, this plugin asks for the PIN only when switching profiles and never stores it.{"\n"}
        5. If Plex denies a managed profile switch or server access, use a Plex account/home flow that can switch profiles on plex.tv first.
        </Forms.FormText>
        </>
    ),

    async start() {
        plexAccountToken = settings.store.plexToken || null;
        currentToken = null;
        artAssetCache.clear();
        if (settings.store.showControlWidget) mountWidget(widgetCallbacks);
        if (plexAccountToken) {
            await refreshAuthForServer();
        }
        await tick();
        const intervalSeconds = Math.max(5, settings.store.pollInterval || 15);
        pollTimer = setInterval(tick, intervalSeconds * 1000);
    },

    stop() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        clearActivity();
        unmountWidget();
        resetRuntimeAuth();
        lastRatingKey = null;
        currentPlayerMachineId = null;
        tickInFlight = false;
        commandInFlight = false;
        localShuffle = false;
        localRepeat = false;
        artAssetCache.clear();
    }
});

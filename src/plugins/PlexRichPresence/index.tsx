/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * PlexRichPresence — Vencord plugin
 */

import { definePluginSettings } from "@api/Settings";
import { PluginNative } from "@utils/types";
import definePlugin, { OptionType } from "@utils/types";
import { ApplicationAssetUtils, Button, FluxDispatcher, Forms, Toasts } from "@webpack/common";

import { mountWidget, unmountWidget, updateWidget, WidgetState } from "./widget";

interface PlexHomeUser {
    id: string;
    title: string;
    username?: string;
    restricted: boolean;
    protected: boolean;
}

interface PlexCurrentUser {
    id: string | null;
    title: string | null;
    username: string | null;
    email: string | null;
    home: boolean;
}

interface PlexResourceConnection {
    address: string | null;
    local: boolean;
    protocol: string | null;
    relay: boolean;
    uri: string | null;
}

interface PlexResource {
    accessToken: string | null;
    clientIdentifier: string;
    name: string;
    owned: boolean;
    ownerTitle: string | null;
    provides: string[];
    selectedConnection: PlexResourceConnection | null;
    supportsPlayerCommands: boolean;
}

const Native = VencordNative.pluginHelpers.PlexRichPresence as PluginNative<typeof import("./native")>;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let loginPollActive = false;
let tickInFlight = false;
let commandInFlight = false;

let plexAccountToken: string | null = null;
let currentToken: string | null = null;
let currentServerUri: string | null = null;
let currentPlexUser: PlexCurrentUser | null = null;
let selectedResource: PlexResource | null = null;
let canControlPlayback = false;

let cachedResources: PlexResource[] = [];
let cachedHomeUsers: PlexHomeUser[] = [];

let lastStatusMessageKey: string | null = null;
let lastRatingKey: string | null = null;
let currentPlayerMachineId: string | null = null;
let lastKnownPlaying = false;
let localShuffle = false;
let localRepeat = false;

interface CachedArt {
    assetId: string | undefined;
    artUrl: string | null;
    dataUrl: string | null;
}

const artAssetCache = new Map<string, CachedArt>();
const ART_CACHE_LIMIT = 200;

const FALLBACK_ART_URL = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/plex.png";

function toast(message: string, type: "MESSAGE" | "SUCCESS" | "FAILURE" = "MESSAGE") {
    const toastApi = Toasts as any;
    toastApi.show({
        id: toastApi.genId(),
        type: toastApi.Type[type],
        message
    });
}

function normalizeString(value: string | null | undefined) {
    return String(value ?? "").trim().toLowerCase();
}

function normalizeUri(uri: string | null | undefined) {
    return String(uri ?? "").trim().replace(/\/$/, "").toLowerCase();
}

function notifyOnce(key: string, message: string, type: "MESSAGE" | "SUCCESS" | "FAILURE" = "MESSAGE") {
    if (lastStatusMessageKey === key) return;
    lastStatusMessageKey = key;
    toast(message, type);
}

function clearStatusNotice() {
    lastStatusMessageKey = null;
}

function getPreferredConnection(resource: PlexResource): PlexResourceConnection | null {
    return resource.selectedConnection?.uri ? resource.selectedConnection : null;
}

function resourceConnectionLabel(connection: PlexResourceConnection | null) {
    if (!connection) return "Unknown connection";
    if (connection.local && !connection.relay) return "Local direct";
    if (connection.relay) return "Relay";
    return "Remote direct";
}

function buildResourceLabel(resource: PlexResource, includeUri = false) {
    const owner = resource.owned ? "You" : resource.ownerTitle || "Shared";
    const connection = getPreferredConnection(resource);
    const connectionLabel = resourceConnectionLabel(connection);
    const uri = connection?.uri ? ` • ${connection.uri}` : "";
    return `${resource.name} • owner: ${owner} • ${connectionLabel}${includeUri ? uri : ""}`;
}

function sortResources(resources: PlexResource[]) {
    return [...resources].sort((a, b) => {
        const aConn = getPreferredConnection(a);
        const bConn = getPreferredConnection(b);
        const aLocal = aConn?.local ? 1 : 0;
        const bLocal = bConn?.local ? 1 : 0;
        if (aLocal !== bLocal) return bLocal - aLocal;

        const aRelay = aConn?.relay ? 1 : 0;
        const bRelay = bConn?.relay ? 1 : 0;
        if (aRelay !== bRelay) return aRelay - bRelay;

        return a.name.localeCompare(b.name);
    });
}

function clearSelectedResourceSettings() {
    settings.store.selectedResourceId = "";
    settings.store.selectedResourceName = "";
    settings.store.selectedResourceUri = "";
}

function saveSelectedResourceSettings(resource: PlexResource) {
    const connection = getPreferredConnection(resource);
    settings.store.selectedResourceId = resource.clientIdentifier;
    settings.store.selectedResourceName = resource.name;
    settings.store.selectedResourceUri = connection?.uri ?? "";
}

function resetStoredAuth() {
    settings.store.plexToken = "";
    settings.store.homeUserId = "";
    settings.store.homeUserTitle = "";
    clearSelectedResourceSettings();
}

function resetRuntimeContext() {
    currentToken = null;
    currentServerUri = null;
    currentPlexUser = null;
    selectedResource = null;
    currentPlayerMachineId = null;
    canControlPlayback = false;
    lastKnownPlaying = false;
    localShuffle = false;
    localRepeat = false;
    tickInFlight = false;
    commandInFlight = false;
}

function resetRuntimeAndCaches() {
    resetRuntimeContext();
    cachedResources = [];
    cachedHomeUsers = [];
}

async function pollPin(id: number): Promise<string | null> {
    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const token = await Native.checkPin(id).catch(() => null);
        if (token) return token;
    }
    return null;
}

async function fetchCurrentUser(token: string) {
    return await Native.fetchCurrentUser(token).catch(() => null);
}

async function fetchHomeUsersForAccount() {
    if (!plexAccountToken) return [];
    const users = await Native.fetchHomeUsers(plexAccountToken).catch(() => []);
    cachedHomeUsers = Array.isArray(users) ? users : [];
    return cachedHomeUsers;
}

async function pickEffectiveHomeUser() {
    const configuredHomeUserId = settings.store.homeUserId?.trim();
    const configuredHomeUserTitle = settings.store.homeUserTitle?.trim();

    if (!configuredHomeUserId && !configuredHomeUserTitle) return null;

    const users = cachedHomeUsers.length ? cachedHomeUsers : await fetchHomeUsersForAccount();
    if (!users.length) return null;

    let selected = configuredHomeUserId
        ? users.find(u => u.id === configuredHomeUserId)
        : undefined;

    if (!selected && configuredHomeUserTitle) {
        selected = users.find(u => normalizeString(u.title) === normalizeString(configuredHomeUserTitle));
        if (selected) settings.store.homeUserId = selected.id;
    }

    return selected ?? null;
}

async function switchToConfiguredHomeUser(baseToken: string, accountUser: PlexCurrentUser) {
    const selectedHomeUser = await pickEffectiveHomeUser();
    if (!selectedHomeUser) {
        if (settings.store.homeUserId || settings.store.homeUserTitle) {
            notifyOnce(
                "home-user-not-found",
                "The configured Plex Home profile is no longer available. Pick another profile.",
                "FAILURE"
            );
            settings.store.homeUserId = "";
            settings.store.homeUserTitle = "";
        }

        return {
            effectiveToken: baseToken,
            effectiveUser: accountUser,
            switched: false
        };
    }

    settings.store.homeUserTitle = selectedHomeUser.title;

    let pin: string | undefined;
    if (selectedHomeUser.protected) {
        const enteredPin = window.prompt(`Enter Plex Home PIN for \"${selectedHomeUser.title}\"`, "");
        if (enteredPin === null) {
            notifyOnce("home-switch-cancelled", "Plex Home switch cancelled.", "MESSAGE");
            return null;
        }
        pin = enteredPin.trim() || undefined;
    }

    const switched = await Native.switchHomeUser(baseToken, selectedHomeUser.id, pin).catch(() => null);
    if (!switched?.token) {
        notifyOnce(
            switched?.needsPin ? "home-switch-pin-required" : "home-switch-failed",
            switched?.needsPin
                ? `Could not switch to \"${selectedHomeUser.title}\". Verify the Plex Home PIN and retry.`
                : `Plex denied access to \"${selectedHomeUser.title}\". Log in with an eligible Plex Home owner/profile first.`,
            "FAILURE"
        );
        return null;
    }

    const switchedUser = await fetchCurrentUser(switched.token);

    return {
        effectiveToken: switched.token,
        effectiveUser: switchedUser ?? {
            id: selectedHomeUser.id,
            title: selectedHomeUser.title,
            username: selectedHomeUser.username ?? null,
            email: null,
            home: true
        },
        switched: true
    };
}

async function migrateLegacyServerUrl(resources: PlexResource[], token: string) {
    const legacyServerUrl = settings.store.serverUrl?.trim();
    if (!legacyServerUrl) return null;

    const normalizedLegacy = normalizeUri(legacyServerUrl);

    let match = resources.find(resource => normalizeUri(resource.selectedConnection?.uri) === normalizedLegacy);
    if (match) return match;

    const machineIdentifier = await Native.fetchServerMachineIdentifier(legacyServerUrl, token).catch(() => null);
    if (!machineIdentifier) return null;

    match = resources.find(resource => resource.clientIdentifier === machineIdentifier);
    return match ?? null;
}

function pickResourceFromSettings(resources: PlexResource[]) {
    const selectedId = settings.store.selectedResourceId?.trim();
    const selectedUri = settings.store.selectedResourceUri?.trim();

    if (selectedId) {
        const byId = resources.find(resource => resource.clientIdentifier === selectedId);
        if (byId) return byId;
    }

    if (selectedUri) {
        const byUri = resources.find(resource => normalizeUri(resource.selectedConnection?.uri) === normalizeUri(selectedUri));
        if (byUri) return byUri;
    }

    return null;
}

async function establishPlaybackContext(forceRefreshResources = false) {
    if (!plexAccountToken) return false;

    const accountUser = await fetchCurrentUser(plexAccountToken);
    if (!accountUser) {
        resetStoredAuth();
        resetRuntimeAndCaches();
        plexAccountToken = null;
        notifyOnce("auth-expired", "Your Plex login has expired. Please log in again.", "FAILURE");
        return false;
    }

    const switched = await switchToConfiguredHomeUser(plexAccountToken, accountUser);
    if (!switched) {
        resetRuntimeContext();
        return false;
    }

    const effectiveToken = switched.effectiveToken;
    const effectiveUser = switched.effectiveUser;

    if (forceRefreshResources || !cachedResources.length) {
        cachedResources = sortResources(await Native.fetchResources(effectiveToken).catch(() => []));
    }

    if (!cachedResources.length) {
        clearSelectedResourceSettings();
        resetRuntimeContext();
        notifyOnce(
            "no-resources",
            "No Plex Media Server is accessible for this Plex account/profile. Ask the server owner to share a server and retry.",
            "FAILURE"
        );
        return false;
    }

    let resource = pickResourceFromSettings(cachedResources);

    if (!resource) {
        resource = await migrateLegacyServerUrl(cachedResources, effectiveToken);
        if (resource) {
            saveSelectedResourceSettings(resource);
            notifyOnce("legacy-migrated", `Migrated legacy Plex server URL to discovered resource: ${resource.name}`, "SUCCESS");
        }
    }

    if (!resource) {
        resource = cachedResources[0];
        saveSelectedResourceSettings(resource);
    }

    const resourceUri = getPreferredConnection(resource)?.uri;
    const resourceToken = resource.accessToken || effectiveToken;

    if (!resourceUri || !resourceToken) {
        clearSelectedResourceSettings();
        resetRuntimeContext();
        notifyOnce(
            "resource-missing-connection",
            "The selected Plex resource does not expose a usable connection/token. Choose another server.",
            "FAILURE"
        );
        return false;
    }

    currentToken = resourceToken;
    currentServerUri = resourceUri;
    currentPlexUser = effectiveUser;
    selectedResource = resource;
    canControlPlayback = resource.supportsPlayerCommands;

    settings.store.homeUserTitle = effectiveUser.title ?? settings.store.homeUserTitle;
    saveSelectedResourceSettings(resource);

    return true;
}

async function startPlexLogin() {
    if (loginPollActive) {
        toast("Login already in progress. Finish it in your browser.", "MESSAGE");
        return;
    }

    const pin = await Native.requestPin().catch(() => null);
    if (!pin) {
        toast("Could not contact Plex to start login.", "FAILURE");
        return;
    }

    const authUrl =
        "https://app.plex.tv/auth#?clientID=vencord-plex-rich-presence" +
        `&code=${encodeURIComponent(pin.code)}` +
        "&context%5Bdevice%5D%5Bproduct%5D=Vencord%20Plex%20Rich%20Presence";

    window.open(authUrl, "_blank");

    toast(
        `Browser opened for Plex login. If needed, go to plex.tv/link and enter code: ${pin.code}`,
        "MESSAGE"
    );

    loginPollActive = true;
    const token = await pollPin(pin.id);
    loginPollActive = false;

    if (!token) {
        toast("Login timed out before Plex returned a token. Try again.", "FAILURE");
        return;
    }

    settings.store.plexToken = token;
    plexAccountToken = token;

    resetRuntimeAndCaches();
    artAssetCache.clear();

    const ready = await establishPlaybackContext(true);
    if (!ready) {
        toast("Plex account linked. Choose a usable Plex Home profile or server resource.", "MESSAGE");
        return;
    }

    clearStatusNotice();
    toast("Plex account linked successfully.", "SUCCESS");
    void tick();
}

async function chooseHomeUser() {
    if (!plexAccountToken) {
        toast("Log in with Plex first.", "FAILURE");
        return;
    }

    const users = await fetchHomeUsersForAccount();
    if (!users.length) {
        toast("No Plex Home profiles are available for this account.", "FAILURE");
        return;
    }

    const currentId = settings.store.homeUserId?.trim();

    const optionsText = users.map((u, i) => {
        const role = u.restricted ? "managed" : "full";
        const pin = u.protected ? ", PIN" : "";
        const active = currentId && u.id === currentId ? " [selected]" : "";
        return `${i + 1}. ${u.title} (${role}${pin})${active}`;
    }).join("\n");

    const response = window.prompt(
        "Select the Plex Home profile to use for session matching.\n" +
        "Leave blank to use the main Plex account profile.\n\n" +
        optionsText,
        currentId ? String(users.findIndex(u => u.id === currentId) + 1) : ""
    );

    if (response === null) return;

    const value = response.trim();
    if (!value) {
        settings.store.homeUserId = "";
        settings.store.homeUserTitle = "";
        resetRuntimeContext();
        const ok = await establishPlaybackContext(true);
        if (ok) {
            toast("Using the main Plex account profile.", "SUCCESS");
            void tick();
        }
        return;
    }

    const index = Number(value);
    if (!Number.isInteger(index) || index < 1 || index > users.length) {
        toast("Invalid selection. Use one of the listed profile numbers.", "FAILURE");
        return;
    }

    const selected = users[index - 1];
    settings.store.homeUserId = selected.id;
    settings.store.homeUserTitle = selected.title;

    resetRuntimeContext();
    const ok = await establishPlaybackContext(true);

    if (ok) {
        toast(`Selected Plex Home profile: ${selected.title}`, "SUCCESS");
        void tick();
    }
}

async function chooseResource() {
    if (!plexAccountToken) {
        toast("Log in with Plex first.", "FAILURE");
        return;
    }

    const ready = await establishPlaybackContext(true);
    if (!ready || !cachedResources.length) return;

    const resources = sortResources(cachedResources);
    const currentId = settings.store.selectedResourceId?.trim();

    const options = resources.map((resource, index) => {
        const selected = currentId && resource.clientIdentifier === currentId ? " [selected]" : "";
        return `${index + 1}. ${buildResourceLabel(resource, true)}${selected}`;
    }).join("\n");

    const response = window.prompt(
        "Select which Plex server resource to use.\n" +
        "Resources are listed with owner, connection type, and selected URI.\n\n" +
        options,
        currentId ? String(resources.findIndex(r => r.clientIdentifier === currentId) + 1) : ""
    );

    if (response === null) return;

    const value = response.trim();
    if (!value) {
        toast("Selection cancelled.", "MESSAGE");
        return;
    }

    const index = Number(value);
    if (!Number.isInteger(index) || index < 1 || index > resources.length) {
        toast("Invalid selection. Use one of the listed resource numbers.", "FAILURE");
        return;
    }

    const selected = resources[index - 1];
    saveSelectedResourceSettings(selected);
    resetRuntimeContext();

    const ok = await establishPlaybackContext(false);
    if (!ok) return;

    toast(`Selected Plex resource: ${buildResourceLabel(selected)}`, "SUCCESS");
    void tick();
}

async function sendCommand(command: string, params?: Record<string, string>) {
    if (commandInFlight) return;

    if (!canControlPlayback || !currentToken || !currentPlayerMachineId || !currentServerUri) {
        toast("Playback control is unavailable for this Plex session/resource.", "FAILURE");
        return;
    }

    commandInFlight = true;
    try {
        const result = await Native
            .sendPlayerCommand(currentServerUri, currentToken, currentPlayerMachineId, command, params ?? {})
            .catch((e: any) => ({ ok: false, unauthorized: false, error: String(e) }));

        if (!result?.ok) {
            if (result?.unauthorized) {
                canControlPlayback = false;
                notifyOnce(
                    "player-control-denied",
                    "Plex denied playback control for this account/resource. Rich Presence will continue without controls.",
                    "FAILURE"
                );
                return;
            }

            console.error("[PlexRichPresence] Command failed:", command, result?.error);
            toast(`Plex command failed: ${command}`, "FAILURE");
            return;
        }

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
        void sendCommand("setParameters", { shuffle: localShuffle ? "1" : "0" });
    },
    onRepeatToggle: () => {
        localRepeat = !localRepeat;
        void sendCommand("setParameters", { repeat: localRepeat ? "1" : "0" });
    },
    onSeek: (offsetMs: number) => {
        void sendCommand("seekTo", { offset: String(Math.round(offsetMs)) });
    }
};

function formatExternalAsset(url: string): string | undefined {
    if (!url) return undefined;
    if (url.startsWith("mp:")) return url;
    if (!/^https?:\/\//i.test(url)) return undefined;

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
    if (thumb && currentToken && currentServerUri) {
        const baseUrl = currentServerUri.replace(/\/$/, "");
        localPlexUrl = `${baseUrl}${thumb}?X-Plex-Token=${encodeURIComponent(currentToken)}`;
    }

    const coverResult = await Native.fetchOnlineCover(artist, album, title, localPlexUrl).catch(() => null);
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

function sessionMatchesCurrentUser(session: any) {
    if (!currentPlexUser) return true;

    const sessionUserId = session?.User?.id != null ? String(session.User.id) : null;
    if (sessionUserId && currentPlexUser.id && sessionUserId === currentPlexUser.id) return true;

    const sessionUserTitle = normalizeString(session?.User?.title);
    const candidates = [
        normalizeString(currentPlexUser.title),
        normalizeString(currentPlexUser.username),
        normalizeString(currentPlexUser.email),
    ].filter(Boolean);

    if (!sessionUserTitle) return candidates.length === 0;
    return candidates.includes(sessionUserTitle);
}

async function tick() {
    if (tickInFlight) return;

    if (!currentToken || !currentServerUri || !currentPlexUser) {
        const prepared = await establishPlaybackContext(false);
        if (!prepared) return;
    }

    if (!currentToken || !currentServerUri) return;

    tickInFlight = true;

    try {
        const result = await Native.fetchSessions(currentServerUri, currentToken).catch(e => {
            console.error("[PlexRichPresence] fetchSessions failed:", e);
            return null;
        });

        if (!result) {
            notifyOnce("sessions-fetch-error", "Failed to contact Plex server for sessions.", "FAILURE");
            return;
        }

        if (result.unauthorized || !result.sessions) {
            clearActivity();
            lastRatingKey = null;
            currentPlayerMachineId = null;
            updateWidget(null);

            clearSelectedResourceSettings();
            resetRuntimeContext();

            notifyOnce(
                "sessions-unauthorized",
                "The selected Plex server/profile cannot access /status/sessions. Select another server or ask the owner to grant access.",
                "FAILURE"
            );
            return;
        }

        if (result.error) {
            notifyOnce("sessions-error", `Plex session request failed: ${result.error}`, "FAILURE");
            return;
        }

        const mySession = result.sessions.find((s: any) => s.type === "track" && sessionMatchesCurrentUser(s));

        if (!mySession) {
            if (lastRatingKey !== null) {
                clearActivity();
                lastRatingKey = null;
            }
            currentPlayerMachineId = null;
            if (settings.store.showControlWidget) updateWidget(null);
            clearStatusNotice();
            return;
        }

        const { activity, widgetArtUrl } = await buildActivity(mySession);
        setActivity(activity);
        lastRatingKey = mySession.ratingKey;

        currentPlayerMachineId = mySession.Player?.machineIdentifier ?? null;
        lastKnownPlaying = mySession.Player?.state === "playing";
        if (typeof mySession.Player?.shuffle === "boolean") localShuffle = mySession.Player.shuffle;
        if (typeof mySession.Player?.repeat === "boolean") localRepeat = mySession.Player.repeat;

        canControlPlayback = Boolean(selectedResource?.supportsPlayerCommands && currentPlayerMachineId);

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
                timestamp: Date.now(),
                controlsEnabled: canControlPlayback
            };
            updateWidget(widgetState);
        }

        clearStatusNotice();
    } finally {
        tickInFlight = false;
    }
}

const settings = definePluginSettings({
    loginButton: {
        type: OptionType.COMPONENT,
        description: "Authenticate with Plex (official browser flow, no password in Vencord)",
        component: () => (
            <Button onClick={() => void startPlexLogin()}>
                Log in with Plex
            </Button>
        )
    },
    logoutButton: {
        type: OptionType.COMPONENT,
        description: "Clear Plex authentication and selected profile/server",
        component: () => (
            <Button
                color={Button.Colors.RED}
                onClick={() => {
                    resetStoredAuth();
                    plexAccountToken = null;
                    resetRuntimeAndCaches();
                    clearActivity();
                    updateWidget(null);
                    clearStatusNotice();
                    artAssetCache.clear();
                    toast("Plex login cleared.", "SUCCESS");
                }}
            >
                Log out from Plex
            </Button>
        )
    },
    homeUserButton: {
        type: OptionType.COMPONENT,
        description: "Choose which Plex Home profile identity should be matched",
        component: () => (
            <Button onClick={() => void chooseHomeUser()}>
                Choose Plex Home Profile
            </Button>
        )
    },
    resourceButton: {
        type: OptionType.COMPONENT,
        description: "Choose the Plex server resource discovered for the current account/profile",
        component: () => (
            <Button onClick={() => void chooseResource()}>
                Choose Plex Server Resource
            </Button>
        )
    },
    selectedResourceName: {
        type: OptionType.STRING,
        description: "Selected Plex resource label",
        default: "",
        hidden: true
    },
    selectedResourceId: {
        type: OptionType.STRING,
        description: "Selected Plex resource identifier",
        default: "",
        hidden: true
    },
    selectedResourceUri: {
        type: OptionType.STRING,
        description: "Selected Plex resource URI",
        default: "",
        hidden: true
    },
    plexToken: {
        type: OptionType.STRING,
        description: "Stored Plex account token from OAuth login",
        default: "",
        hidden: true
    },
    homeUserId: {
        type: OptionType.STRING,
        description: "Stored Plex Home user identifier",
        default: "",
        hidden: true
    },
    homeUserTitle: {
        type: OptionType.STRING,
        description: "Stored Plex Home user title",
        default: "",
        hidden: true
    },
    serverUrl: {
        type: OptionType.STRING,
        description: "Legacy manual Plex Media Server URL (deprecated, used only for migration)",
        default: "",
        hidden: true
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
        description: "Discord Application ID (optional)",
        default: ""
    },
    showControlWidget: {
        type: OptionType.BOOLEAN,
        description: "Show playback controls panel above user profile (disabled automatically if control permission is missing)",
        default: true
    }
});

export default definePlugin({
    name: "PlexRichPresence",
    description: "Shows what you're listening to on Plex in Discord, Spotify-style.",
    authors: [{ name: "p4rzl", id: 547438743284482050n }],
    settings,

    settingsAboutComponent: () => (
        <>
            <Forms.FormTitle tag="h3">Setup</Forms.FormTitle>
            <Forms.FormText>
                1. Press 'Log in with Plex' and approve the official Plex browser flow.{"\n"}
                2. Optional: press 'Choose Plex Home Profile' if you use managed/shared Plex Home identities.{"\n"}
                3. Press 'Choose Plex Server Resource' when multiple servers are available. Resources show owner, connection type, and URI.{"\n"}
                4. This plugin uses the selected resource URI/access token from Plex account resources (manual server URL is deprecated).{"\n"}
                5. If /status/sessions is denied, choose another resource or ask the server owner to grant session access for this Plex profile.
            </Forms.FormText>
        </>
    ),

    async start() {
        plexAccountToken = settings.store.plexToken || null;
        resetRuntimeAndCaches();
        artAssetCache.clear();
        clearStatusNotice();

        if (settings.store.showControlWidget) mountWidget(widgetCallbacks);

        if (plexAccountToken) {
            await establishPlaybackContext(true);
            await tick();
        }

        const intervalSeconds = Math.max(5, settings.store.pollInterval || 15);
        pollTimer = setInterval(() => void tick(), intervalSeconds * 1000);
    },

    stop() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        clearActivity();
        unmountWidget();
        resetRuntimeAndCaches();
        lastRatingKey = null;
        clearStatusNotice();
        artAssetCache.clear();
    }
});

/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { ApplicationAssetUtils, Button, FluxDispatcher, Forms, showToast } from "@webpack/common";

import { isPublicCoverUrl } from "./artwork";
import { activityData, PlaybackLifetime, supportsCommand } from "./playback";
import { CLIENT_IDENTIFIER, safeBaseUrl, serverUrl } from "./plex";
import type { FailureKind, Playback, PlayerCommand, PlexCurrentUser, PlexResource } from "./types";
import { PlayerWidget, updateWidget } from "./widget";

const Native = VencordNative.pluginHelpers.PlexRichPresence as PluginNative<typeof import("./native")>;
// Public Plex RPC application used by phin05/discord-rich-presence-plex; can be overridden.
const DEFAULT_APPLICATION_ID = "413407336082833418";
const FALLBACK_ART_URL = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/plex.png";
const lifetime = new PlaybackLifetime();
const assets = new Map<string, { id: string; expires: number; }>();
let timer: ReturnType<typeof setTimeout> | null = null;
let loginActive = false;
let commandActive = false;
let setupActive = false;
let needsProfileSelection = false;
let noticeKey = "";
let playback: Playback | null = null;
let effectiveToken: string | null = null;
let effectiveUser: PlexCurrentUser | null = null;
let resources: PlexResource[] = [];
let resourcesAt = 0;
let diagnostics: Record<string, string | number | boolean | null> = { state: "stopped" };
let displayedArt: { key: string; expires: number; assetId?: string; dataUrl: string | null; matched: boolean; } | null = null;

function setActivity(activity: ReturnType<typeof activityData> | null) {
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: "PlexRichPresence" });
}

function clearPlayback() {
    playback = null;
    setActivity(null);
    updateWidget(null);
    displayedArt = null;
}

function notice(key: string, text: string) {
    if (noticeKey === key) return;
    noticeKey = key;
    showToast(text, "failure");
}

function failure(kind: FailureKind, stage: string, status: number) {
    diagnostics = { state: "error", stage, kind, status };
    const messages: Record<FailureKind, string> = {
        unauthorized: "Plex rejected this token. Refresh resources or log in again.",
        forbidden: "Plex denied access. Player timeline fallback needs a reachable Plex Companion player belonging to this profile.",
        network: "Plex is unreachable. Check remote access, relay or your connection. Your login has been kept.",
        http: `Plex returned HTTP ${status}. Your login has been kept.`,
        invalid: "Plex returned an unsupported response. Open plugin diagnostics."
    };
    notice(`${stage}:${kind}:${status}`, messages[kind]);
}

function invalidateContext() {
    lifetime.invalidate();
    effectiveToken = null;
    effectiveUser = null;
    resources = [];
    resourcesAt = 0;
    clearPlayback();
    assets.clear();
    noticeKey = "";
    void Native.resetContext().catch(() => {});
}

async function runAction(action: () => Promise<void>) {
    if (setupActive) return;
    setupActive = true;
    try { await action(); } catch {
        notice("setup-error", "Plex setup failed. Try again; no credentials were logged.");
    } finally { setupActive = false; }
}

async function ensureContext(generation: number) {
    const accountToken = settings.store.plexToken;
    if (!accountToken || needsProfileSelection) return false;
    if (!effectiveToken || !effectiveUser) {
        const account = await Native.fetchCurrentUser(accountToken);
        if (!lifetime.current(generation)) return false;
        if (!account.ok) {
            failure(account.kind, "account", account.status);
            if (account.kind === "unauthorized") {
                settings.store.plexToken = "";
                invalidateContext();
            }
            return false;
        }
        let token = accountToken;
        let user = account.value;
        const homeId = settings.store.homeUserId;
        // Earlier versions stored the main account name as a Home selection even without switching.
        if (!homeId && [user.title, user.username].includes(settings.store.homeUserTitle)) settings.store.homeUserTitle = "";
        if (homeId || settings.store.homeUserTitle) {
            const home = await Native.fetchHomeUsers(accountToken);
            if (!lifetime.current(generation)) return false;
            if (!home.ok) { failure(home.kind, "home", home.status); return false; }
            const selected = home.value.find(u => homeId ? u.id === homeId : u.title === settings.store.homeUserTitle);
            if (!selected) {
                needsProfileSelection = true;
                notice("missing-profile", "The selected Plex Home profile is unavailable. Choose a profile; the account owner will not be substituted.");
                return false;
            }
            if (selected.protected) {
                needsProfileSelection = true;
                notice("profile-pin", "Choose your Plex Home profile and enter its PIN to reconnect. PINs are never stored.");
                return false;
            }
            const switched = await Native.switchHomeUser(accountToken, selected.id);
            if (!lifetime.current(generation)) return false;
            if (!switched.ok) { failure(switched.kind, "home-switch", switched.status); return false; }
            const identity = await Native.fetchCurrentUser(switched.value.token);
            if (!lifetime.current(generation)) return false;
            if (!identity.ok) { failure(identity.kind, "profile", identity.status); return false; }
            token = switched.value.token;
            user = { id: selected.id, title: selected.title, username: selected.username ?? null, email: null, home: true };
            settings.store.homeUserId = selected.id;
        }
        effectiveToken = token;
        effectiveUser = user;
    }
    if (!resources.length || Date.now() - resourcesAt > 300_000) {
        const result = await Native.discoverResources(effectiveToken);
        if (!lifetime.current(generation)) return false;
        if (!result.ok) { failure(result.kind, "resources", result.status); return false; }
        resources = result.value;
        resourcesAt = Date.now();
        // Preserve the server choice by identifier, even when its LAN address changes.
        if (!settings.store.selectedResourceId) {
            const legacy = safeBaseUrl(settings.store.serverUrl || settings.store.selectedResourceUri || "");
            let selected = resources.find(r => r.provides.includes("server") && r.connections.some(c => c.uri === legacy));
            if (!selected && legacy) {
                const id = await Native.fetchServerMachineIdentifier(legacy, effectiveToken);
                if (!lifetime.current(generation)) return false;
                selected = resources.find(r => r.clientIdentifier === id && r.provides.includes("server"));
            }
            selected ??= resources.find(r => r.provides.includes("server"));
            if (selected) {
                settings.store.selectedResourceId = selected.clientIdentifier;
                settings.store.selectedResourceName = selected.name;
            }
        }
    }
    return true;
}

async function registerAsset(applicationId: string, url: string) {
    const key = `${applicationId}:${url}`;
    const cached = assets.get(key);
    if (cached && cached.expires > Date.now()) return cached.id;
    try {
        const [id] = await ApplicationAssetUtils.fetchAssetIds(applicationId, [url]);
        if (id) {
            if (assets.size >= 100) assets.delete(assets.keys().next().value!);
            assets.set(key, { id, expires: Date.now() + 1_800_000 });
            return id;
        }
    } catch { /* Retry on a later poll; never invent a media proxy ID. */ }
    return undefined;
}

async function tick() {
    const generation = lifetime.begin();
    if (generation === null) return;
    try {
        if (!await ensureContext(generation)) {
            if (lifetime.current(generation)) clearPlayback();
            return;
        }
        const server = resources.find(r => r.clientIdentifier === settings.store.selectedResourceId && r.provides.includes("server"));
        if (!server || !effectiveUser || !effectiveToken) {
            clearPlayback();
            notice("no-server", "The selected Plex server is unavailable for this profile. Choose an accessible server.");
            return;
        }
        const result = await Native.fetchPlayback(server, effectiveUser, effectiveToken, resources, settings.store.preferredPlayerId, settings.store.companionUrl);
        if (!lifetime.current(generation)) return;
        if (!result.playback) {
            clearPlayback();
            if (result.error && result.error !== "no-player") {
                if (result.error === "unauthorized") resourcesAt = 0;
                failure(result.error, "playback", result.status);
                Object.assign(diagnostics, {
                    ownPlayers: resources.filter(r => r.owned && r.provides.includes("player")).length,
                    preferredPlayer: Boolean(settings.store.preferredPlayerId), companionProbe: Boolean(settings.store.companionUrl)
                });
            } else if (result.error === "no-player") {
                notice("missing-player", "The preferred Plex player is unavailable. Choose another player or automatic detection.");
            } else {
                noticeKey = "";
                diagnostics = { state: "idle", status: result.status };
            }
            return;
        }
        const observed = result.playback;
        settings.store.selectedResourceUri = observed.serverUri;
        playback = observed;
        const { track } = observed;
        const appId = settings.store.applicationId.trim() || DEFAULT_APPLICATION_ID;
        if (!/^\d{17,20}$/.test(appId)) {
            clearPlayback();
            notice("application-id", "The Discord Application ID must be a numeric application identifier, not a token.");
            return;
        }
        const artKey = `${appId}:${server.clientIdentifier}:${track.parentThumb || track.thumb}:${track.originalTitle || track.grandparentTitle}:${track.parentTitle || track.title}:${settings.store.showAlbumArt}`;
        if (displayedArt?.key === artKey && displayedArt.expires > Date.now()) {
            setActivity(activityData(observed, appId, displayedArt.assetId));
            updateWidget({ playback: observed, artUrl: displayedArt.dataUrl });
        } else {
            // Publish new metadata immediately while looking up the cover, not the previous track's image.
            setActivity(activityData(observed, appId));
            updateWidget({ playback: observed, artUrl: null });
            let assetId: string | undefined;
            let widgetArt: string | null = null;
            let matched = false;
            if (settings.store.showAlbumArt) {
                const thumb = track.parentThumb || track.thumb || track.grandparentThumb;
                const localUrl = thumb?.startsWith("/library/") ? serverUrl(observed.serverUri, thumb) : null;
                const art = await Native.fetchOnlineCover(
                    track.originalTitle || track.grandparentTitle || "", track.parentTitle || "", track.title || "",
                    localUrl, server.accessToken || effectiveToken
                );
                if (!lifetime.current(generation)) return;
                widgetArt = art.dataUrl;
                matched = Boolean(art.artUrl && isPublicCoverUrl(art.artUrl));
                const publicUrl = matched ? art.artUrl! : FALLBACK_ART_URL;
                assetId = await registerAsset(appId, publicUrl);
                if (!lifetime.current(generation)) return;
                if (!assetId && publicUrl !== FALLBACK_ART_URL) {
                    matched = false;
                    assetId = await registerAsset(appId, FALLBACK_ART_URL);
                    if (!lifetime.current(generation)) return;
                }
            }
            setActivity(activityData(observed, appId, assetId));
            updateWidget({ playback: observed, artUrl: widgetArt });
            displayedArt = { key: artKey, expires: Date.now() + (assetId && matched ? 600_000 : 30_000), assetId, dataUrl: widgetArt, matched };
        }
        noticeKey = "";
        diagnostics = {
            state: observed.playing ? "playing" : "paused", source: observed.source,
            connection: server.connections.find(c => c.uri === observed.serverUri)?.relay ? "relay" :
                server.connections.find(c => c.uri === observed.serverUri)?.local ? "local" : "remote",
            sharedServer: !server.owned, controls: Boolean(observed.control), publicAsset: Boolean(displayedArt?.assetId),
            cover: !settings.store.showAlbumArt ? "disabled" : displayedArt?.matched ? "catalog" : "fallback",
            homeProfile: Boolean(settings.store.homeUserId)
        };
    } catch {
        if (lifetime.current(generation)) {
            clearPlayback();
            notice("poll-error", "Could not update Plex presence. Open diagnostics; no credentials were logged.");
            diagnostics = { state: "error", stage: "poll" };
        }
    } finally { lifetime.end(); }
}

function schedulePoll() {
    if (timer) clearTimeout(timer);
    const generation = lifetime.capture();
    if (!lifetime.current(generation)) return;
    const seconds = Math.min(300, Math.max(5, Number(settings.store.pollInterval) || 15));
    timer = setTimeout(async () => {
        timer = null;
        await tick();
        // A profile change invalidates results, but not the active polling loop.
        if (lifetime.current(lifetime.capture())) schedulePoll();
    }, seconds * 1000);
}

async function startPlexLogin() {
    if (loginActive) return;
    loginActive = true;
    const generation = lifetime.capture();
    try {
        const pin = await Native.requestPin();
        if (!lifetime.current(generation)) return;
        if (!pin) { notice("login-failed", "Could not start Plex login."); return; }
        const url = `https://app.plex.tv/auth#?clientID=${CLIENT_IDENTIFIER}&code=${encodeURIComponent(pin.code)}&context%5Bdevice%5D%5Bproduct%5D=Vencord%20Plex%20Rich%20Presence`;
        window.open(url, "_blank", "noopener,noreferrer");
        showToast(`Approve Plex login in your browser. Link code: ${pin.code}`);
        for (let i = 0; i < 60 && lifetime.current(generation); i++) {
            await new Promise(r => setTimeout(r, 2000));
            if (!lifetime.current(generation)) return;
            const token = await Native.checkPin(pin.id);
            if (!lifetime.current(generation)) return;
            if (!token) continue;
            settings.store.plexToken = token;
            settings.store.homeUserId = "";
            settings.store.homeUserTitle = "";
            needsProfileSelection = false;
            invalidateContext();
            showToast("Plex account linked.", "success");
            await tick();
            return;
        }
        if (lifetime.current(generation)) notice("login-timeout", "Plex login timed out. Try again.");
    } finally { loginActive = false; }
}

async function chooseHomeUser() {
    if (!settings.store.plexToken) { notice("login-needed", "Log in with Plex first."); return; }
    const generation = lifetime.capture();
    const result = await Native.fetchHomeUsers(settings.store.plexToken);
    if (!lifetime.current(generation)) return;
    if (!result.ok) { failure(result.kind, "home", result.status); return; }
    const answer = window.prompt(`Choose Plex Home profile (0 = main account):\n${result.value.map((u, i) => `${i + 1}. ${u.title}${u.protected ? " (PIN)" : ""}`).join("\n")}`, "0");
    if (answer === null || !answer.trim()) return;
    const index = Number(answer);
    if (!Number.isInteger(index) || index < 0 || index > result.value.length) return;
    if (!index) {
        settings.store.homeUserId = "";
        settings.store.homeUserTitle = "";
        needsProfileSelection = false;
        invalidateContext();
        await tick();
        return;
    }
    const selected = result.value[index - 1];
    const pin = selected.protected ? window.prompt(`Plex Home PIN for ${selected.title}`, "") : undefined;
    if (pin === null) return;
    const switched = await Native.switchHomeUser(settings.store.plexToken, selected.id, pin?.trim());
    if (!lifetime.current(generation)) return;
    if (!switched.ok) { failure(switched.kind, "home-switch", switched.status); return; }
    const identity = await Native.fetchCurrentUser(switched.value.token);
    if (!lifetime.current(generation)) return;
    if (!identity.ok) { failure(identity.kind, "profile", identity.status); return; }
    invalidateContext();
    settings.store.homeUserId = selected.id;
    settings.store.homeUserTitle = selected.title;
    needsProfileSelection = false;
    effectiveToken = switched.value.token;
    effectiveUser = { id: selected.id, title: selected.title, username: selected.username ?? null, email: null, home: true };
    await tick();
}

async function chooseResource(player = false) {
    const generation = lifetime.capture();
    resourcesAt = 0;
    if (!await ensureContext(generation) || !lifetime.current(generation)) return;
    const choices = resources.filter(r => player ? r.owned && r.provides.includes("player") : r.provides.includes("server"));
    if (!choices.length && !player) { notice("no-resources", "No shared or owned Plex servers were found."); return; }
    const response = window.prompt(`Choose ${player ? "player (0 = automatic)" : "server"}:\n${choices.map((r, i) => `${i + 1}. ${r.name}${!r.owned ? " (shared)" : ""}`).join("\n")}`, player ? "0" : "1");
    if (response === null || !response.trim()) return;
    const index = Number(response);
    if (!Number.isInteger(index) || index < (player ? 0 : 1) || index > choices.length) return;
    lifetime.invalidate();
    clearPlayback();
    if (player) settings.store.preferredPlayerId = index ? choices[index - 1].clientIdentifier : "";
    else {
        settings.store.selectedResourceId = choices[index - 1].clientIdentifier;
        settings.store.selectedResourceName = choices[index - 1].name;
        settings.store.selectedResourceUri = "";
    }
    await Native.resetContext();
    await tick();
}

async function sendCommand(command: PlayerCommand, params: Record<string, string> = {}) {
    if (commandActive || !playback?.control || !supportsCommand(playback.control.capabilities, command, params)) return;
    commandActive = true;
    const generation = lifetime.capture();
    try {
        const result = await Native.sendPlayerCommand(playback.playerId, command, params);
        if (!lifetime.current(generation)) return;
        if (!result.ok) {
            playback.control = null;
            updateWidget({ playback, artUrl: null });
            failure(result.kind, "control", result.status);
            return;
        }
        await tick();
    } catch {
        if (lifetime.current(generation)) notice("command-error", "Plex player command failed.");
    } finally { commandActive = false; }
}

const settings = definePluginSettings({
    loginButton: { type: OptionType.COMPONENT, description: "Official Plex browser login", component: () => <Button onClick={() => void runAction(startPlexLogin)}>Log in with Plex</Button> },
    logoutButton: {
        type: OptionType.COMPONENT, description: "Clear Plex authentication", component: () => <Button color={Button.Colors.RED} onClick={() => {
            settings.store.plexToken = "";
            settings.store.homeUserId = "";
            settings.store.homeUserTitle = "";
            settings.store.selectedResourceId = "";
            settings.store.selectedResourceName = "";
            settings.store.selectedResourceUri = "";
            settings.store.preferredPlayerId = "";
            settings.store.serverUrl = "";
            needsProfileSelection = false;
            invalidateContext();
            diagnostics = { state: "logged-out" };
        }}>Log out from Plex</Button>
    },
    homeUserButton: { type: OptionType.COMPONENT, description: "Select your Plex Home identity", component: () => <Button onClick={() => void runAction(chooseHomeUser)}>Choose Plex Home Profile</Button> },
    resourceButton: { type: OptionType.COMPONENT, description: "Select an owned or shared server", component: () => <Button onClick={() => void runAction(() => chooseResource())}>Choose Plex Server Resource</Button> },
    playerButton: { type: OptionType.COMPONENT, description: "Select a preferred player for session/timeline detection", component: () => <Button onClick={() => void runAction(() => chooseResource(true))}>Choose Plex Player</Button> },
    companionUrl: { type: OptionType.STRING, description: "Optional Plexamp Companion endpoint (blank disables probing). Its ID must match a player owned by this profile; use a trusted endpoint only", default: "http://127.0.0.1:32500", onChange: () => { lifetime.invalidate(); clearPlayback(); } },
    diagnosticsButton: { type: OptionType.COMPONENT, description: "Show safe diagnostics (no credentials, addresses or track titles)", component: () => <Button onClick={() => window.alert(JSON.stringify(diagnostics, null, 2))}>Show diagnostics</Button> },
    plexToken: { type: OptionType.STRING, description: "Plex account token", default: "", hidden: true },
    homeUserId: { type: OptionType.STRING, description: "Plex Home profile ID", default: "", hidden: true },
    homeUserTitle: { type: OptionType.STRING, description: "Plex Home profile name", default: "", hidden: true },
    selectedResourceId: { type: OptionType.STRING, description: "Selected server identifier", default: "", hidden: true },
    selectedResourceName: { type: OptionType.STRING, description: "Selected server name", default: "", hidden: true },
    selectedResourceUri: { type: OptionType.STRING, description: "Last working server connection", default: "", hidden: true },
    preferredPlayerId: { type: OptionType.STRING, description: "Preferred Plex player identifier", default: "", hidden: true },
    serverUrl: { type: OptionType.STRING, description: "Legacy server URL for migration", default: "", hidden: true },
    pollInterval: { type: OptionType.NUMBER, description: "Polling interval in seconds (5–300)", default: 15, onChange: schedulePoll },
    showAlbumArt: { type: OptionType.BOOLEAN, description: "Show artwork. Artist/album metadata is sent to iTunes/Deezer; private images are never uploaded", default: true, onChange: () => { lifetime.invalidate(); clearPlayback(); } },
    applicationId: { type: OptionType.STRING, description: "Optional Discord Application ID (blank uses the public Plex RPC application)", default: "", onChange: () => { lifetime.invalidate(); clearPlayback(); assets.clear(); } },
    showControlWidget: { type: OptionType.BOOLEAN, description: "Show playback widget above the account panel", default: true }
});

export default definePlugin({
    name: "PlexRichPresence",
    description: "Shows your Plex music playback on Discord, with public album artwork and optional controls.",
    authors: [{ name: "p4rzl", id: 547438743284482050n }],
    hidden: IS_WEB,
    settings,
    patches: [{
        find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
        replacement: {
            match: /(?<=\i\.jsxs?\)\()(\i),{(?=[^}]*?userTag:\i,occluded:)/,
            replace: "$self.PanelWrapper,{VencordOriginal:$1,"
        }
    }],
    PanelWrapper({ VencordOriginal, ...props }) {
        const { showControlWidget } = settings.use(["showControlWidget"]);
        return <>
            {showControlWidget && <ErrorBoundary noop><PlayerWidget onCommand={(command, params) => void sendCommand(command, params)} /></ErrorBoundary>}
            <VencordOriginal {...props} />
        </>;
    },
    settingsAboutComponent: () => <>
        <Forms.FormTitle tag="h3">Setup</Forms.FormTitle>
        <Forms.FormText>
            Log in with Plex, then choose your profile and shared/owned server. Select a player if you use multiple devices.
            Remote server connections and relay are tried automatically. If server sessions are denied, your own reachable
            Plex Companion player's timeline is used instead. A phone on another network may not expose a reachable timeline.
            Album covers for Discord come only from public catalogs; unmatched albums use the Plex icon. Enable activity sharing in Discord.
        </Forms.FormText>
    </>,
    start() {
        if (IS_WEB) return;
        lifetime.start();
        needsProfileSelection = false;
        invalidateContext();
        diagnostics = { state: settings.store.plexToken ? "connecting" : "logged-out" };
        void tick();
        schedulePoll();
    },
    stop() {
        if (IS_WEB) return;
        lifetime.stop();
        if (timer) clearTimeout(timer);
        timer = null;
        invalidateContext();
        diagnostics = { state: "stopped" };
    }
});

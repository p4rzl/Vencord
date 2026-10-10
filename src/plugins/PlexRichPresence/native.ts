/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { clearArtworkCache, resolveArtwork } from "./artwork";
import { selectSession, supportsCommand } from "./playback";
import { booleanValue, connectionOrder, metadata, normalizeResources, plexHeaders, request, requestData, safeBaseUrl, serverUrl } from "./plex";
import type { Playback, PlaybackResult, PlayerCommand, PlexCurrentUser, PlexHomeUser, PlexResource, Result } from "./types";

const connectionCache = new Map<string, string>();
const commandCounters = new Map<string, number>();
const controlTargets = new Map<string, Playback["control"]>();
const activeRequests = new Set<AbortController>();
let contextVersion = 0;

function nextCommandId(id: string) {
    const n = (commandCounters.get(id) ?? 0) + 1;
    commandCounters.set(id, n);
    return n;
}

function userFromData(data: any): PlexCurrentUser | null {
    const user = Array.isArray(data) ? data[0]?.attrs : data;
    if (!user?.id) return null;
    return {
        id: String(user.id), title: user.title ?? user.username ?? null,
        username: user.username ?? null, email: user.email ?? null, home: booleanValue(user.home)
    };
}

export async function requestPin(_: unknown) {
    const result = await requestData("https://plex.tv/api/v2/pins", {
        method: "POST", headers: plexHeaders(undefined, { "Content-Type": "application/x-www-form-urlencoded" }), body: "strong=true"
    });
    if (!result.ok || !result.value?.id || !result.value?.code) return null;
    return { id: Number(result.value.id), code: String(result.value.code) };
}

export async function checkPin(_: unknown, id: number) {
    const result = await requestData(`https://plex.tv/api/v2/pins/${encodeURIComponent(id)}`, { headers: plexHeaders() });
    return result.ok ? result.value?.authToken ?? null : null;
}

export async function fetchCurrentUser(_: unknown, token: string): Promise<Result<PlexCurrentUser>> {
    const result = await requestData("https://plex.tv/api/v2/user", { headers: plexHeaders(token) });
    if (!result.ok) return result;
    const user = userFromData(result.value);
    return user ? { ok: true, value: user } : { ok: false, kind: "invalid", status: 200 };
}

export async function fetchHomeUsers(_: unknown, token: string): Promise<Result<PlexHomeUser[]>> {
    const result = await requestData("https://plex.tv/api/home/users", { headers: plexHeaders(token) });
    if (!result.ok) return result;
    const data = result.value;
    const users = Array.isArray(data) && data[0]?.tag ? data[0].children.map((n: any) => n.attrs) : data.users ?? data;
    if (!Array.isArray(users)) return { ok: false, kind: "invalid", status: 200 };
    return { ok: true, value: users.filter(u => u.id && (u.title || u.username)).map(u => ({
        id: String(u.id), title: String(u.title || u.username), username: u.username,
        protected: booleanValue(u.protected), restricted: booleanValue(u.restricted)
    })) };
}

export async function switchHomeUser(_: unknown, token: string, userId: string, pin?: string): Promise<Result<{ token: string; }>> {
    const params = new URLSearchParams();
    if (pin) params.set("pin", pin);
    const result = await requestData(`https://plex.tv/api/home/users/${encodeURIComponent(userId)}/switch${params.size ? `?${params}` : ""}`, {
        method: "POST", headers: plexHeaders(token)
    });
    if (!result.ok) return result;
    const user = Array.isArray(result.value) ? result.value[0]?.attrs : result.value;
    const switchedToken = user?.authToken ?? user?.authenticationToken;
    return switchedToken ? { ok: true, value: { token: String(switchedToken) } } : { ok: false, kind: "invalid", status: 200 };
}

export async function discoverResources(_: unknown, token: string): Promise<Result<PlexResource[]>> {
    const result = await requestData("https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1", { headers: plexHeaders(token) });
    if (!result.ok) return result;
    return { ok: true, value: normalizeResources(result.value) };
}

export async function fetchResources(_: unknown, token: string): Promise<PlexResource[]> {
    const result = await discoverResources(null, token);
    return result.ok ? result.value.filter(r => r.provides.includes("server")) : [];
}

async function onResource(
    resource: PlexResource, token: string, path: string, extra: Record<string, string> = {},
    validate: (data: any) => boolean = () => true
): Promise<Result<{ data: any; uri: string; }>> {
    const connections = connectionOrder(resource.connections, connectionCache.get(resource.clientIdentifier));
    if (!connections.length) return { ok: false, kind: "network", status: 0 };
    const controller = new AbortController();
    activeRequests.add(controller);
    const probe = async (uri: string) => {
        const result = await requestData(serverUrl(uri, path), { headers: plexHeaders(token, extra), signal: controller.signal });
        if (!result.ok) throw result;
        if (!validate(result.value)) throw { ok: false, kind: "invalid", status: 200 };
        return { data: result.value, uri };
    };
    try {
        const preferred = connectionCache.get(resource.clientIdentifier);
        if (preferred && connections.some(c => c.uri === preferred)) {
            try { return { ok: true, value: await probe(preferred) }; } catch { connectionCache.delete(resource.clientIdentifier); }
        }
        const failures: Array<Extract<Result<never>, { ok: false; }>> = [];
        // Race direct connections first; relay is a fallback, not a competitor to a healthy direct connection.
        for (const group of [connections.filter(c => !c.relay), connections.filter(c => c.relay)]) {
            if (!group.length || controller.signal.aborted) continue;
            try {
                const value = await Promise.any(group.map(c => probe(c.uri)));
                connectionCache.set(resource.clientIdentifier, value.uri);
                return { ok: true, value };
            } catch (e) {
                failures.push(...(e as AggregateError).errors);
            }
        }
        return failures.find(f => f.kind === "forbidden") ?? failures.find(f => f.kind === "unauthorized") ?? failures.find(f => f.status > 0) ?? { ok: false, kind: "network", status: 0 };
    } finally {
        controller.abort();
        activeRequests.delete(controller);
    }
}

export async function fetchServerMachineIdentifier(_: unknown, uri: string, token: string) {
    const base = safeBaseUrl(uri);
    if (!base) return null;
    const result = await requestData(serverUrl(base, "/identity"), { headers: plexHeaders(token) });
    if (!result.ok) return null;
    const data = result.value;
    return Array.isArray(data) ? data[0]?.attrs.machineIdentifier ?? null : data?.MediaContainer?.machineIdentifier ?? null;
}

export async function fetchSessions(_: unknown, uri: string, token: string) {
    const base = safeBaseUrl(uri);
    const result = base ? await requestData(serverUrl(base, "/status/sessions"), { headers: plexHeaders(token) }) : { ok: false as const, kind: "invalid" as const, status: 0 };
    if (!result.ok) return { unauthorized: result.kind === "unauthorized" || result.kind === "forbidden", status: result.status, sessions: null, error: result.kind };
    const sessions = metadata(result.value);
    return { unauthorized: false, status: 200, sessions, error: sessions ? null : "invalid" };
}

interface Timeline {
    state: string;
    type: string;
    machineIdentifier?: string;
    ratingKey?: string;
    key?: string;
    time?: string | number;
    duration?: string | number;
    shuffle?: string | number;
    repeat?: string | number;
    controllable?: string;
}

function timelineEntries(data: any): Timeline[] | null {
    const entries = Array.isArray(data) && data[0]?.tag === "MediaContainer"
        ? data[0].children.filter((n: any) => n.tag === "Timeline").map((n: any) => n.attrs)
        : data?.MediaContainer?.Timeline;
    return Array.isArray(entries) ? entries : null;
}

async function playerTimeline(player: PlexResource, token: string): Promise<Result<{ timeline: Timeline | null; uri: string; }>> {
    const result = await onResource(player, token, `/player/timeline/poll?wait=0&commandID=${nextCommandId(player.clientIdentifier)}`, {
        "X-Plex-Target-Client-Identifier": player.clientIdentifier
    }, data => timelineEntries(data) !== null);
    if (!result.ok) return result;
    const { data, uri } = result.value;
    const entries = timelineEntries(data)!;
    return { ok: true, value: { uri, timeline: entries.find(t => t.type === "music" && ["playing", "paused", "buffering"].includes(t.state)) ?? null } };
}

async function addCompanionConnection(resources: PlexResource[], uri: string): Promise<PlexResource[]> {
    const base = safeBaseUrl(uri);
    if (!base || !resources.some(r => r.owned && r.provides.includes("player"))) return resources;
    // Identify the local endpoint without sending credentials. Never attach an unknown/another profile's player.
    const result = await requestData(serverUrl(base, "/resources"), { headers: plexHeaders() });
    if (!result.ok) return resources;
    const data = result.value;
    const entries = Array.isArray(data) && data[0]?.tag === "MediaContainer"
        ? data[0].children.filter((n: any) => ["Player", "Device"].includes(n.tag)).map((n: any) => n.attrs)
        : data?.MediaContainer?.Player ?? data?.MediaContainer?.Device ?? [];
    if (!Array.isArray(entries)) return resources;
    const identifiers = entries.map(p => String(p.machineIdentifier || p.clientIdentifier || ""));
    return resources.map(r => r.owned && r.provides.includes("player") && identifiers.includes(r.clientIdentifier)
        ? { ...r, connections: [...r.connections.filter(c => c.uri !== base), {
            uri: base, address: new URL(base).hostname, protocol: new URL(base).protocol.slice(0, -1),
            local: ["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname), relay: false
        }] }
        : r);
}

export async function fetchPlayback(
    _: unknown, server: PlexResource, user: PlexCurrentUser, token: string,
    resources: PlexResource[], preferredPlayerId: string, companionUri = ""
): Promise<PlaybackResult> {
    const version = contextVersion;
    controlTargets.clear();
    const serverToken = server.accessToken || token;
    const sessionResult = await onResource(server, serverToken, "/status/sessions", {}, data => metadata(data) !== null);
    const sessionTracks = sessionResult.ok ? metadata(sessionResult.value.data) : null;
    const session = sessionTracks ? selectSession(sessionTracks, user, preferredPlayerId) : null;
    const playerResources = companionUri ? await addCompanionConnection(resources, companionUri) : resources;
    if (version !== contextVersion) return { playback: null, serverUri: null, error: "network", status: 0 };
    const players = playerResources.filter(r => r.owned && r.provides.includes("player") &&
        (!preferredPlayerId || r.clientIdentifier === preferredPlayerId) &&
        (!session || r.clientIdentifier === session.Player?.machineIdentifier));

    const timelines = await Promise.all(players.map(async player => ({ player, result: await playerTimeline(player, player.accessToken || token) })));
    const matching = timelines.filter(t => t.result.ok && t.result.value.timeline?.machineIdentifier === server.clientIdentifier);
    const active = matching.find(t => t.result.ok && t.result.value.timeline?.state === "playing") ?? matching.find(t => t.result.ok && t.result.value.timeline);
    const timeline = active?.result.ok ? active.result.value.timeline : null;
    const control = active?.result.ok && timeline ? {
        uri: active.result.value.uri, token: active.player.accessToken || token,
        capabilities: String(timeline.controllable ?? "").split(",").map(c => c.trim()).filter(Boolean)
    } : null;
    if (session) {
        const playerId = session.Player?.machineIdentifier ?? "";
        // Never enable controls for a different track/server than the observed session.
        const matchingControl = timeline?.machineIdentifier === server.clientIdentifier && String(timeline.ratingKey) === String(session.ratingKey) ? control : null;
        if (matchingControl && version === contextVersion) controlTargets.set(playerId, matchingControl);
        return {
            serverUri: sessionResult.ok ? sessionResult.value.uri : null, error: null, status: 200,
            playback: {
                track: session, playing: session.Player?.state === "playing", observedAt: Date.now(), source: "sessions",
                serverUri: sessionResult.ok ? sessionResult.value.uri : "", playerId,
                playerName: session.Player?.title || "Plex player", control: matchingControl,
                shuffle: booleanValue(timeline?.shuffle), repeat: Number(timeline?.repeat) || 0
            }
        };
    }

    // The player's timeline exposes only that player's playback; library metadata uses the shared server token.
    if (active && timeline && timeline.machineIdentifier === server.clientIdentifier) {
        const key = timeline.key || (timeline.ratingKey ? `/library/metadata/${encodeURIComponent(timeline.ratingKey)}` : "");
        if (/^\/library\/metadata\/[^/?#]+$/.test(key)) {
            const details = await onResource(server, serverToken, key, {}, data => Boolean(metadata(data)?.[0]?.type === "track"));
            const track = details.ok ? metadata(details.value.data)?.[0] : null;
            if (track?.type === "track" && details.ok) {
                if (control && version === contextVersion) controlTargets.set(active.player.clientIdentifier, control);
                return {
                    serverUri: details.value.uri, error: null, status: 200,
                    playback: {
                        track: {
                            ...track, viewOffset: Number(timeline.time) || 0, duration: Number(timeline.duration) || Number(track.duration) || 0,
                            Player: { machineIdentifier: active.player.clientIdentifier, title: active.player.name, state: timeline.state }
                        },
                        playing: timeline.state === "playing", shuffle: booleanValue(timeline.shuffle), repeat: Number(timeline.repeat) || 0,
                        observedAt: Date.now(), source: "player", serverUri: details.value.uri,
                        playerId: active.player.clientIdentifier, playerName: active.player.name, control
                    }
                };
            }
        }
    }
    return {
        playback: null, serverUri: sessionResult.ok ? sessionResult.value.uri : null,
        error: !sessionResult.ok ? sessionResult.kind : !sessionTracks ? "invalid" : preferredPlayerId && !players.length ? "no-player" : null,
        status: sessionResult.ok ? 200 : sessionResult.status
    };
}

export async function sendPlayerCommand(_: unknown, playerId: string, command: PlayerCommand, params: Record<string, string> = {}): Promise<Result<null>> {
    const target = controlTargets.get(playerId);
    if (!target || !supportsCommand(target.capabilities, command, params)) return { ok: false, kind: "forbidden", status: 403 };
    if (!["play", "pause", "skipNext", "skipPrevious", "seekTo", "setParameters"].includes(command)) return { ok: false, kind: "invalid", status: 0 };
    const allowed = command === "seekTo" ? ["offset"] : command === "setParameters" ? ["shuffle", "repeat"] : [];
    if (Object.entries(params).some(([key, value]) => !allowed.includes(key) || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) ||
        command === "seekTo" && params.offset === undefined ||
        params.shuffle !== undefined && !["0", "1"].includes(params.shuffle) ||
        params.repeat !== undefined && !["0", "1", "2"].includes(params.repeat)) return { ok: false, kind: "invalid", status: 0 };
    const query = new URLSearchParams({ ...params, type: "music", commandID: String(nextCommandId(playerId)) });
    const result = await request(serverUrl(target.uri, `/player/playback/${command}?${query}`), {
        headers: plexHeaders(target.token, { "X-Plex-Target-Client-Identifier": playerId })
    });
    if (!result.ok) { controlTargets.delete(playerId); return result; }
    return { ok: true, value: null };
}

export async function fetchOnlineCover(_: unknown, artist: string, album: string, title: string, localPlexUrl: string | null, token?: string) {
    return resolveArtwork(artist, album, title, localPlexUrl, token);
}

export async function resetContext(_: unknown) {
    contextVersion++;
    for (const controller of activeRequests) controller.abort();
    activeRequests.clear();
    controlTargets.clear();
    connectionCache.clear();
    clearArtworkCache();
}

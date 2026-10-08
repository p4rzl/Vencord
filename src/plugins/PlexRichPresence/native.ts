/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * native.ts — runs in Electron's "main" process.
 */

const CLIENT_IDENTIFIER = "vencord-plex-rich-presence";
const PRODUCT_NAME = "Vencord Plex Rich Presence";
const PRODUCT_VERSION = "1.0";
const PLEX_RESOURCES_URL = "https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1";

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

function plexHeaders(token?: string, extra: Record<string, string> = {}) {
    return {
        Accept: "application/json",
        "X-Plex-Client-Identifier": CLIENT_IDENTIFIER,
        "X-Plex-Product": PRODUCT_NAME,
        "X-Plex-Version": PRODUCT_VERSION,
        "X-Plex-Device": "Vencord",
        "X-Plex-Device-Name": PRODUCT_NAME,
        "X-Plex-Platform": process.platform,
        "X-Plex-Platform-Version": process.version,
        ...(token ? { "X-Plex-Token": token } : {}),
        ...extra
    };
}

function parseXmlAttributes(xmlTag: string) {
    const attrs: Record<string, string> = {};
    for (const [, key, value] of xmlTag.matchAll(/([a-zA-Z0-9:_-]+)="([^"]*)"/g)) {
        attrs[key] = value;
    }
    return attrs;
}

function parseHomeUsersXml(xml: string): PlexHomeUser[] {
    const users: PlexHomeUser[] = [];
    for (const match of xml.matchAll(/<User\b[^>]*>/g)) {
        const attrs = parseXmlAttributes(match[0]);
        const { id } = attrs;
        const title = attrs.title || attrs.username || attrs.email;
        if (!id || !title) continue;
        users.push({
            id,
            title,
            username: attrs.username || undefined,
            restricted: attrs.restricted === "1" || attrs.restricted === "true",
            protected: attrs.protected === "1" || attrs.protected === "true"
        });
    }
    return users;
}

function parseMachineIdentifierFromXml(xml: string): string | null {
    const match = xml.match(/machineIdentifier="([^"]+)"/);
    return match?.[1] ?? null;
}

function parseSwitchTokenXml(xml: string): string | null {
    const match = xml.match(/(?:authenticationToken|authToken)="([^"]+)"/);
    return match?.[1] ?? null;
}

function parseCurrentUserXml(xml: string): PlexCurrentUser | null {
    const match = xml.match(/<user\b[^>]*>/i);
    if (!match) return null;

    const attrs = parseXmlAttributes(match[0]);
    return {
        id: attrs.id ?? null,
        title: attrs.title ?? attrs.username ?? null,
        username: attrs.username ?? null,
        email: attrs.email ?? null,
        home: attrs.home === "1" || attrs.home === "true"
    };
}

function parseResourceConnectionsXml(deviceXml: string): PlexResourceConnection[] {
    const connections: PlexResourceConnection[] = [];

    for (const match of deviceXml.matchAll(/<Connection\b[^>]*\/?>(?:<\/Connection>)?/g)) {
        const attrs = parseXmlAttributes(match[0]);
        connections.push({
            address: attrs.address ?? null,
            local: attrs.local === "1" || attrs.local === "true",
            protocol: attrs.protocol ?? null,
            relay: attrs.relay === "1" || attrs.relay === "true",
            uri: attrs.uri ?? null,
        });
    }

    return connections.filter(c => Boolean(c.uri));
}

function normalizeProvides(value: any): string[] {
    if (Array.isArray(value)) {
        return value.map(v => String(v).trim().toLowerCase()).filter(Boolean);
    }

    if (typeof value === "string") {
        return value.split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
    }

    return [];
}

function connectionScore(connection: PlexResourceConnection): number {
    let score = 0;
    if (connection.local) score += 300;
    if (!connection.relay) score += 120;
    if (connection.protocol?.toLowerCase() === "https") score += 50;
    if (connection.protocol?.toLowerCase() === "http") score += 30;
    if (connection.address) score += 5;
    return score;
}

function pickBestConnection(connections: PlexResourceConnection[]): PlexResourceConnection | null {
    if (!connections.length) return null;

    return [...connections]
        .sort((a, b) => connectionScore(b) - connectionScore(a))
        .find(c => Boolean(c.uri)) ?? null;
}

function normalizeResourceFromJson(resource: any): PlexResource | null {
    const clientIdentifier = String(resource?.clientIdentifier ?? "").trim();
    if (!clientIdentifier) return null;

    const provides = normalizeProvides(resource?.provides);
    if (!provides.includes("server")) return null;

    const connectionsRaw = Array.isArray(resource?.connections) ? resource.connections : [];
    const connections: PlexResourceConnection[] = connectionsRaw
        .map((conn: any) => ({
            address: conn?.address ? String(conn.address) : null,
            local: Boolean(conn?.local),
            protocol: conn?.protocol ? String(conn.protocol) : null,
            relay: Boolean(conn?.relay),
            uri: conn?.uri ? String(conn.uri) : null
        }))
        .filter(conn => Boolean(conn.uri));

    const selectedConnection = pickBestConnection(connections);

    return {
        accessToken: resource?.accessToken ? String(resource.accessToken) : null,
        clientIdentifier,
        name: String(resource?.name ?? resource?.product ?? "Unknown server"),
        owned: Boolean(resource?.owned),
        ownerTitle: resource?.sourceTitle ? String(resource.sourceTitle) : null,
        provides,
        selectedConnection,
        supportsPlayerCommands: provides.includes("server")
    };
}

function parseResourcesXml(xml: string): PlexResource[] {
    const resources: PlexResource[] = [];

    for (const match of xml.matchAll(/<Device\b[^>]*>[\s\S]*?<\/Device>/g)) {
        const rawDevice = match[0];
        const openTag = rawDevice.match(/<Device\b[^>]*>/)?.[0];
        if (!openTag) continue;

        const attrs = parseXmlAttributes(openTag);
        const provides = normalizeProvides(attrs.provides);
        if (!attrs.clientIdentifier || !provides.includes("server")) continue;

        const connections = parseResourceConnectionsXml(rawDevice);
        const selectedConnection = pickBestConnection(connections);

        resources.push({
            accessToken: attrs.accessToken ?? null,
            clientIdentifier: attrs.clientIdentifier,
            name: attrs.name || attrs.product || "Unknown server",
            owned: attrs.owned === "1" || attrs.owned === "true",
            ownerTitle: attrs.sourceTitle ?? null,
            provides,
            selectedConnection,
            supportsPlayerCommands: provides.includes("server")
        });
    }

    return resources;
}

function buildServerUrl(serverUrl: string, path: string, params?: URLSearchParams): string {
    const base = serverUrl.replace(/\/$/, "");
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = `${base}${normalizedPath}`;
    if (!params || !params.size) return url;
    return `${url}?${params.toString()}`;
}

/**
 * Cleans track/artist/album metadata for accurate API lookup.
 */
function cleanText(str: string): string {
    if (!str) return "";
    return str
        .replace(/\[.*?\]/g, "")
        .replace(/\(.*?\)/g, "")
        .replace(/#\w+/g, "")
        .replace(/\bfeat\..*$/gi, "")
        .replace(/\bft\..*$/gi, "")
        .trim();
}

export async function requestPin(_: any) {
    try {
        const res = await fetch("https://plex.tv/api/v2/pins", {
            method: "POST",
            headers: plexHeaders(undefined, { "Content-Type": "application/x-www-form-urlencoded" }),
            body: "strong=true"
        });
        if (!res.ok) return null;
        const data: any = await res.json();
        return { id: data.id, code: data.code };
    } catch (e) {
        console.error("[PlexRichPresence:native] Failed to request a login code:", e);
        return null;
    }
}

export async function checkPin(_: any, id: number) {
    try {
        const res = await fetch(`https://plex.tv/api/v2/pins/${encodeURIComponent(String(id))}`, {
            headers: plexHeaders()
        });
        if (!res.ok) return null;
        const data: any = await res.json();
        return data.authToken ?? null;
    } catch (e) {
        console.error("[PlexRichPresence:native] Failed to check the login code:", e);
        return null;
    }
}

export async function fetchCurrentUser(_: any, token: string): Promise<PlexCurrentUser | null> {
    try {
        const res = await fetch("https://plex.tv/api/v2/user", {
            headers: plexHeaders(token, { Accept: "application/json, application/xml;q=0.9, text/xml;q=0.8" })
        });

        if (!res.ok) return null;

        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            const data: any = await res.json();
            return {
                id: data?.id != null ? String(data.id) : null,
                title: data?.title ? String(data.title) : data?.username ? String(data.username) : null,
                username: data?.username ? String(data.username) : null,
                email: data?.email ? String(data.email) : null,
                home: Boolean(data?.home)
            };
        }

        return parseCurrentUserXml(await res.text());
    } catch {
        return null;
    }
}

export async function fetchHomeUsers(_: any, token: string) {
    try {
        const res = await fetch("https://plex.tv/api/home/users", {
            headers: plexHeaders(token, { Accept: "application/json, application/xml;q=0.9, text/xml;q=0.8" })
        });
        if (!res.ok) return [];

        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            const data: any = await res.json();
            const users = Array.isArray(data?.users) ? data.users : Array.isArray(data) ? data : [];
            return users
                .map((u: any) => ({
                    id: String(u?.id ?? ""),
                    title: String(u?.title ?? u?.username ?? u?.email ?? ""),
                    username: u?.username ? String(u.username) : undefined,
                    restricted: Boolean(u?.restricted),
                    protected: Boolean(u?.protected)
                }))
                .filter((u: PlexHomeUser) => u.id && u.title);
        }

        return parseHomeUsersXml(await res.text());
    } catch (e) {
        console.error("[PlexRichPresence:native] Failed to fetch Plex Home users:", e);
        return [];
    }
}

export async function switchHomeUser(_: any, token: string, userId: string, pin?: string) {
    try {
        const params = new URLSearchParams();
        if (pin) params.set("pin", pin);
        const url = `https://plex.tv/api/home/users/${encodeURIComponent(userId)}/switch${params.size ? `?${params.toString()}` : ""}`;
        const res = await fetch(url, {
            method: "POST",
            headers: plexHeaders(token, { Accept: "application/json, application/xml;q=0.9, text/xml;q=0.8" })
        });

        if (res.status === 401 || res.status === 403 || res.status === 422) {
            return { token: null, unauthorized: true, needsPin: true, error: null };
        }
        if (!res.ok) {
            return { token: null, unauthorized: false, needsPin: false, error: `Server responded with status ${res.status}` };
        }

        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            const data: any = await res.json();
            const switchedToken = data?.authToken ?? data?.authenticationToken ?? null;
            return { token: switchedToken, unauthorized: false, needsPin: false, error: null };
        }

        const switchedToken = parseSwitchTokenXml(await res.text());
        return { token: switchedToken, unauthorized: false, needsPin: false, error: null };
    } catch (e: any) {
        const message = e?.cause?.message || e?.message || String(e);
        console.error("[PlexRichPresence:native] Failed to switch Plex Home user:", e);
        return { token: null, unauthorized: false, needsPin: false, error: message };
    }
}

export async function fetchResources(_: any, token: string): Promise<PlexResource[]> {
    try {
        const res = await fetch(PLEX_RESOURCES_URL, {
            headers: plexHeaders(token, { Accept: "application/json, application/xml;q=0.9, text/xml;q=0.8" })
        });

        if (!res.ok) return [];

        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            const data: any = await res.json();
            const resources = Array.isArray(data) ? data : Array.isArray(data?.resources) ? data.resources : [];
            return resources
                .map(normalizeResourceFromJson)
                .filter((resource: PlexResource | null): resource is PlexResource => Boolean(resource && resource.selectedConnection?.uri));
        }

        return parseResourcesXml(await res.text()).filter(resource => Boolean(resource.selectedConnection?.uri));
    } catch (e) {
        console.error("[PlexRichPresence:native] Failed to fetch Plex resources:", e);
        return [];
    }
}

export async function fetchServerMachineIdentifier(_: any, serverUrl: string, token: string) {
    try {
        const url = buildServerUrl(serverUrl, "/identity");
        const res = await fetch(url, {
            headers: plexHeaders(token, { Accept: "application/json, application/xml;q=0.9, text/xml;q=0.8" })
        });
        if (!res.ok) return null;

        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            const data: any = await res.json();
            return data?.MediaContainer?.machineIdentifier ?? data?.machineIdentifier ?? null;
        }

        return parseMachineIdentifierFromXml(await res.text());
    } catch {
        return null;
    }
}

const commandCounters = new Map<string, number>();
function nextCommandId(machineIdentifier: string): number {
    const n = (commandCounters.get(machineIdentifier) ?? -1) + 1;
    commandCounters.set(machineIdentifier, n);
    return n;
}

export async function sendPlayerCommand(
    _: any,
    serverUrl: string,
    token: string,
    machineIdentifier: string,
    command: string,
    params: Record<string, string> = {}
) {
    try {
        const qs = new URLSearchParams({
            type: "music",
            commandID: String(nextCommandId(machineIdentifier)),
            ...params
        });
        const url = buildServerUrl(serverUrl, `/player/playback/${encodeURIComponent(command)}`, qs);
        const res = await fetch(url, {
            headers: plexHeaders(token, {
                "X-Plex-Target-Client-Identifier": machineIdentifier,
            })
        });
        if (!res.ok) {
            return {
                ok: false,
                unauthorized: res.status === 401 || res.status === 403,
                error: `Server responded with status ${res.status}`
            };
        }
        return { ok: true, unauthorized: false, error: null };
    } catch (e: any) {
        const message = e?.cause?.message || e?.message || String(e);
        console.error("[PlexRichPresence:native] Player command failed:", command, e);
        return { ok: false, unauthorized: false, error: message };
    }
}

export async function fetchSessions(_: any, serverUrl: string, token: string) {
    try {
        const url = buildServerUrl(serverUrl, "/status/sessions");
        const res = await fetch(url, {
            headers: plexHeaders(token, { Accept: "application/json" })
        });

        if (res.status === 401 || res.status === 403) {
            return { unauthorized: true, status: res.status, sessions: null, error: null };
        }

        if (!res.ok) {
            return {
                unauthorized: false,
                status: res.status,
                sessions: null,
                error: `Server responded with status ${res.status}`
            };
        }

        const data: any = await res.json();
        const sessions = Array.isArray(data?.MediaContainer?.Metadata) ? data.MediaContainer.Metadata : [];
        return { unauthorized: false, status: res.status, sessions, error: null };
    } catch (e: any) {
        const message = e?.cause?.message || e?.message || String(e);
        console.error("[PlexRichPresence:native] Error contacting the Plex Media Server:", e);
        return { unauthorized: false, status: 0, sessions: null, error: message };
    }
}

/**
 * Resolves artwork in the main process so the renderer never has to fetch
 * Plex/third-party images directly. This also gives the controller a data URL,
 * which is much more reliable inside Discord's renderer/CSP.
 *
 * Order:
 * 1. Exact Plex artwork (best match, no external lookup)
 * 2. iTunes artwork
 * 3. Deezer artwork
 */
export async function fetchOnlineCover(_: any, artist: string, album: string, title: string, localPlexUrl: string | null) {
    const cleanArtistStr = cleanText(artist);
    const cleanAlbumStr = cleanText(album);
    const cleanTitleStr = cleanText(title);

    // Prefer Plex's own artwork. It is exact and avoids wrong covers caused by
    // fuzzy third-party searches. Keep it as the controller fallback even when
    // the public upload used by Discord RPC fails.
    let localPlexArt: { artUrl: string; dataUrl: string } | null = null;
    if (localPlexUrl) {
        localPlexArt = await fetchImage(localPlexUrl, "Plex");
        if (localPlexArt?.artUrl) {
            return localPlexArt;
        }
    }

    // iTunes fallback.
    if (cleanArtistStr || cleanTitleStr || cleanAlbumStr) {
        try {
            const query = `${cleanArtistStr} ${cleanAlbumStr} ${cleanTitleStr}`.trim();
            const itunesRes = await fetch(
                `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=5`
            );
            if (itunesRes.ok) {
                const data: any = await itunesRes.json();
                const results = Array.isArray(data?.results) ? data.results : [];
                const artwork = results.find((item: any) => item?.artworkUrl100)?.artworkUrl100;
                if (artwork) {
                    const highResUrl = artwork.replace(/\d+x\d+bb/, "1000x1000bb");
                    // iTunes is already publicly reachable, so keep its HTTPS URL
                    // for RPC. The fetched data URL is only for the local widget.
                    const image = await fetchImage(highResUrl, "iTunes", false);
                    if (image) return image;
                }
            }
        } catch (e) {
            console.warn("[PlexRichPresence:native] iTunes API lookup failed:", e);
        }
    }

    // Deezer fallback.
    if (cleanArtistStr || cleanTitleStr || cleanAlbumStr) {
        try {
            const query = `${cleanArtistStr} ${cleanAlbumStr} ${cleanTitleStr}`.trim();
            const deezerRes = await fetch(
                `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=5`
            );
            if (deezerRes.ok) {
                const data: any = await deezerRes.json();
                const cover = data?.data?.find((item: any) => item?.album?.cover_xl || item?.album?.cover_big)?.album?.cover_xl
                    || data?.data?.[0]?.album?.cover_big
                    || data?.data?.[0]?.album?.cover_medium;
                if (cover) {
                    // Deezer is already publicly reachable, so keep its HTTPS URL
                    // for RPC. The fetched data URL is only for the local widget.
                    const image = await fetchImage(cover, "Deezer", false);
                    if (image) return image;
                }
            }
        } catch (e) {
            console.warn("[PlexRichPresence:native] Deezer API lookup failed:", e);
        }
    }

    // If the exact Plex image was available but could not be made public for
    // Discord, still return it so the controller keeps showing the cover.
    return localPlexArt;
}

async function fetchImage(
    url: string,
    source: string,
    uploadForRpc = true
): Promise<{ artUrl: string; dataUrl: string } | null> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, {
            headers: { "User-Agent": "Vencord Plex Rich Presence" },
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!res.ok) return null;

        const buffer = Buffer.from(await res.arrayBuffer());
        if (!buffer.byteLength) return null;

        const contentType = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
        if (!contentType.startsWith("image/")) return null;

        const dataUrl = `data:${contentType};base64,${buffer.toString("base64")}`;

        // The controller must NOT depend on an external image host or on Plex's
        // private URL. Discord's renderer allows data: images, so always give the
        // controller the bytes we just fetched. The public URL is kept separately
        // for Rich Presence, where Discord needs a remotely reachable image.
        const publicUrl = uploadForRpc ? await uploadBuffer(buffer, contentType) : url;

        return { artUrl: publicUrl || "", dataUrl };
    } catch (e) {
        console.warn(`[PlexRichPresence:native] ${source} artwork fetch failed:`, e);
        return null;
    }
}

async function uploadBuffer(buffer: Buffer, contentType: string): Promise<string | null> {
    try {
        const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(buffer)], { type: contentType }), `cover.${ext}`);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch("https://tmpfiles.org/api/v1/upload", {
            method: "POST",
            body: form,
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (res.ok) {
            const data: any = await res.json();
            if (data?.status === "success" && data?.data?.url) {
                return data.data.url.replace("https://tmpfiles.org/", "https://tmpfiles.org/dl/");
            }
        }
    } catch {
        // The controller can still use the local data URL; RPC just won't have
        // a public image if Discord cannot resolve an external asset.
    }
    return null;
}

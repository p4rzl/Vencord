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
const PLEX_RESOURCES_URL = "https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1";

interface PlexHomeUser {
    id: string;
    title: string;
    restricted: boolean;
    protected: boolean;
}

function plexHeaders(token?: string, extra: Record<string, string> = {}) {
    return {
        Accept: "application/json",
        "X-Plex-Client-Identifier": CLIENT_IDENTIFIER,
        "X-Plex-Product": PRODUCT_NAME,
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

function parseResourceAccessTokenXml(xml: string, machineIdentifier: string): string | null {
    for (const match of xml.matchAll(/<Device\b[^>]*>/g)) {
        const attrs = parseXmlAttributes(match[0]);
        if (attrs.clientIdentifier === machineIdentifier && attrs.accessToken) {
            return attrs.accessToken;
        }
    }
    return null;
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
        const res = await fetch(`https://plex.tv/api/v2/pins/${id}`, {
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

export async function fetchUsername(_: any, token: string) {
    try {
        const res = await fetch("https://plex.tv/api/v2/user", {
            headers: plexHeaders(token)
        });
        if (!res.ok) return null;
        const data: any = await res.json();
        return data?.username ?? data?.title ?? null;
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
        const url = `https://plex.tv/api/home/users/${encodeURIComponent(userId)}/switch${params.size ? `?${params}` : ""}`;
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

export async function fetchServerMachineIdentifier(_: any, serverUrl: string, token: string) {
    try {
        const url = `${serverUrl.replace(/\/$/, "")}/identity`;
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
    } catch (e) {
        console.warn("[PlexRichPresence:native] Failed to fetch server identity:", e);
        return null;
    }
}

export async function resolveServerAccessToken(_: any, token: string, machineIdentifier: string) {
    try {
        const res = await fetch(PLEX_RESOURCES_URL, {
            headers: plexHeaders(token, { Accept: "application/json, application/xml;q=0.9, text/xml;q=0.8" })
        });
        if (!res.ok) return null;

        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            const data: any = await res.json();
            const resources = Array.isArray(data) ? data : Array.isArray(data?.resources) ? data.resources : [];
            const match = resources.find((r: any) => r?.clientIdentifier === machineIdentifier);
            return match?.accessToken ?? null;
        }

        return parseResourceAccessTokenXml(await res.text(), machineIdentifier);
    } catch (e) {
        console.warn("[PlexRichPresence:native] Failed to resolve server-scoped token:", e);
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
        }).toString();
        const url = `${serverUrl.replace(/\/$/, "")}/player/playback/${command}?${qs}`;
        const res = await fetch(url, {
            headers: plexHeaders(token, {
                "X-Plex-Target-Client-Identifier": machineIdentifier,
            })
        });
        if (!res.ok) return { ok: false, error: `Server responded with status ${res.status}` };
        return { ok: true, error: null };
    } catch (e: any) {
        const message = e?.cause?.message || e?.message || String(e);
        console.error("[PlexRichPresence:native] Player command failed:", command, e);
        return { ok: false, error: message };
    }
}

export async function fetchSessions(_: any, serverUrl: string, token: string) {
    try {
        const url = `${serverUrl.replace(/\/$/, "")}/status/sessions`;
        const res = await fetch(url, { headers: plexHeaders(token) });
        if (res.status === 401) return { unauthorized: true, sessions: null, error: null };
        if (!res.ok) {
            return { unauthorized: false, sessions: null, error: `Server responded with status ${res.status}` };
        }
        const data: any = await res.json();
        return { unauthorized: false, sessions: data?.MediaContainer?.Metadata ?? [], error: null };
    } catch (e: any) {
        const message = e?.cause?.message || e?.message || String(e);
        console.error("[PlexRichPresence:native] Error contacting the Plex Media Server:", e);
        return { unauthorized: false, sessions: null, error: message };
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

/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { plexHeaders, request, requestData } from "./plex";
import type { Artwork } from "./types";

const publicCache = new Map<string, { expires: number; url: string | null; }>();
const imageCache = new Map<string, { expires: number; data: string | null; }>();
let cacheVersion = 0;

function normalize(value: string) {
    return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function catalogMatches(artist: string, album: string, title: string, candidate: { artist: string; album: string; title: string; }) {
    if (!artist || normalize(artist) !== normalize(candidate.artist)) return false;
    return album ? normalize(album) === normalize(candidate.album) : Boolean(title && normalize(title) === normalize(candidate.title));
}

export function isPublicCoverUrl(value: string): boolean {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return false;
        return /(^|\.)mzstatic\.com$/.test(url.hostname) || /(^|\.)dzcdn\.net$/.test(url.hostname);
    } catch {
        return false;
    }
}

function put<K, V>(cache: Map<K, V>, key: K, value: V, limit: number) {
    if (cache.size >= limit) cache.delete(cache.keys().next().value!);
    cache.set(key, value);
}

async function imageData(url: string, token?: string): Promise<string | null> {
    const version = cacheVersion;
    const key = `${url}:${token ?? ""}`;
    const cached = imageCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.data;
    const result = await request(url, { headers: token ? plexHeaders(token) : {} });
    let data: string | null = null;
    if (result.ok) {
        const { bytes, contentType } = result.value;
        const mime = contentType.split(";")[0];
        if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime) && bytes.length > 0 && bytes.length <= 2 * 1024 * 1024) {
            data = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
        }
    }
    if (version === cacheVersion) put(imageCache, key, { data, expires: Date.now() + (data ? 600_000 : 30_000) }, 24);
    return data;
}

async function publicCover(artist: string, album: string, title: string): Promise<string | null> {
    const version = cacheVersion;
    const key = `${normalize(artist)}:${normalize(album || title)}`;
    const cached = publicCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.url;
    let url: string | null = null;
    if (artist && (album || title)) {
        const query = new URLSearchParams({ term: `${artist} ${album || title}`, entity: album ? "album" : "song", limit: "15" });
        const itunes = await requestData(`https://itunes.apple.com/search?${query}`);
        if (itunes.ok && Array.isArray(itunes.value?.results)) {
            const match = itunes.value.results.find((r: any) => catalogMatches(artist, album, title, {
                artist: r.artistName ?? "", album: r.collectionName ?? "", title: r.trackName ?? ""
            }) && isPublicCoverUrl(r.artworkUrl100 ?? ""));
            if (match) url = match.artworkUrl100.replace(/\d+x\d+bb/, "600x600bb");
        }
        if (!url) {
            const query = new URLSearchParams({ q: `${artist} ${album || title}`, limit: "15" });
            const deezer = await requestData(`https://api.deezer.com/search?${query}`);
            if (deezer.ok && Array.isArray(deezer.value?.data)) {
                const match = deezer.value.data.find((r: any) => catalogMatches(artist, album, title, {
                    artist: r.artist?.name ?? "", album: r.album?.title ?? "", title: r.title ?? ""
                }) && isPublicCoverUrl(r.album?.cover_xl ?? ""));
                if (match) url = match.album.cover_xl;
            }
        }
    }
    if (version === cacheVersion) put(publicCache, key, { url, expires: Date.now() + (url ? 1_800_000 : 120_000) }, 100);
    return url;
}

export async function resolveArtwork(artist: string, album: string, title: string, localPlexUrl: string | null, plexToken?: string): Promise<Artwork> {
    const [artUrl, localData] = await Promise.all([
        publicCover(artist, album, title),
        localPlexUrl ? imageData(localPlexUrl, plexToken) : null
    ]);
    return { artUrl, dataUrl: localData || (artUrl ? await imageData(artUrl) : null) };
}

export function clearArtworkCache() {
    cacheVersion++;
    publicCache.clear();
    imageCache.clear();
}

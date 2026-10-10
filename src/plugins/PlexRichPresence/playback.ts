/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Playback, PlayerCommand, PlexCurrentUser, PlexTrack } from "./types";

export function sessionMatchesUser(track: PlexTrack, user: PlexCurrentUser): boolean {
    // Plex account IDs and PMS-local user IDs are not always in the same namespace.
    const title = track.User?.title?.trim().toLowerCase();
    const names = [user.title, user.username, user.email].filter(Boolean).map(n => n!.trim().toLowerCase());
    return Boolean(title && names.includes(title));
}

export function selectSession(tracks: PlexTrack[], user: PlexCurrentUser, preferredPlayerId: string): PlexTrack | null {
    const candidates = tracks.filter(t => t.type === "track" && sessionMatchesUser(t, user) &&
        (!preferredPlayerId || t.Player?.machineIdentifier === preferredPlayerId) &&
        ["playing", "paused", "buffering"].includes(t.Player?.state ?? ""));
    return candidates.find(t => t.Player?.state === "playing") ?? candidates[0] ?? null;
}

export function supportsCommand(capabilities: string[], command: PlayerCommand, params: Record<string, string> = {}) {
    if (command === "setParameters") return Object.keys(params).length > 0 && Object.keys(params).every(p => capabilities.includes(p));
    return capabilities.includes(command === "play" || command === "pause" ? "playPause" : command);
}

export function elapsed(playback: Pick<Playback, "track" | "playing" | "observedAt">, now = Date.now()) {
    const duration = Math.max(0, Number(playback.track.duration) || 0);
    const offset = Math.max(0, Number(playback.track.viewOffset) || 0) + (playback.playing ? Math.max(0, now - playback.observedAt) : 0);
    return duration ? Math.min(duration, offset) : offset;
}

export function activityData(playback: Playback, applicationId: string, assetId?: string, now = Date.now()) {
    const { track, playing } = playback;
    const duration = Math.max(0, Number(track.duration) || 0);
    const offset = elapsed(playback, now);
    return {
        application_id: applicationId,
        name: "Plex",
        type: 2,
        flags: 1 << 0,
        details: (track.title || "Unknown track").slice(0, 128),
        state: `${track.originalTitle || track.grandparentTitle || "Unknown artist"}${playing ? "" : track.Player?.state === "buffering" ? " · Buffering" : " · Paused"}`.slice(0, 128),
        ...(playing && duration ? { timestamps: { start: now - offset, end: now - offset + duration } } : {}),
        ...(assetId ? { assets: { large_image: assetId, large_text: (track.parentTitle || "Plex").slice(0, 128) } } : {})
    };
}

// Async results from a previous login/profile/plugin lifetime must never update Discord.
export class PlaybackLifetime {
    private generation = 0;
    private active = false;
    private busy = false;

    start() { this.active = true; this.invalidate(); }
    stop() { this.active = false; this.invalidate(); }
    invalidate() { this.generation++; }
    capture() { return this.generation; }
    current(generation: number) { return this.active && generation === this.generation; }
    begin(): number | null {
        if (!this.active || this.busy) return null;
        this.busy = true;
        return this.generation;
    }
    end() { this.busy = false; }
}

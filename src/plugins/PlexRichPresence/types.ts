/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface PlexHomeUser {
    id: string;
    title: string;
    username?: string;
    restricted: boolean;
    protected: boolean;
}

export interface PlexCurrentUser {
    id: string | null;
    title: string | null;
    username: string | null;
    email: string | null;
    home: boolean;
}

export interface PlexConnection {
    address: string | null;
    local: boolean;
    protocol: string | null;
    relay: boolean;
    uri: string;
}

export interface PlexResource {
    accessToken: string | null;
    clientIdentifier: string;
    name: string;
    owned: boolean;
    ownerTitle: string | null;
    provides: string[];
    connections: PlexConnection[];
    selectedConnection: PlexConnection | null;
    capabilities: string[];
}

export type FailureKind = "unauthorized" | "forbidden" | "network" | "http" | "invalid";
export type Result<T> = { ok: true; value: T; } | { ok: false; kind: FailureKind; status: number; };

export interface PlexTrack {
    type?: string;
    ratingKey?: string;
    key?: string;
    title?: string;
    parentTitle?: string;
    grandparentTitle?: string;
    originalTitle?: string;
    parentThumb?: string;
    thumb?: string;
    grandparentThumb?: string;
    duration?: number;
    viewOffset?: number;
    User?: { id?: string; title?: string; };
    Player?: { machineIdentifier?: string; title?: string; state?: string; };
}

export type PlayerCommand = "play" | "pause" | "skipNext" | "skipPrevious" | "seekTo" | "setParameters";

export interface Playback {
    track: PlexTrack;
    playing: boolean;
    shuffle: boolean;
    repeat: number;
    observedAt: number;
    source: "sessions" | "player";
    serverUri: string;
    playerId: string;
    playerName: string;
    control: { uri: string; token: string; capabilities: string[]; } | null;
}

export interface PlaybackResult {
    playback: Playback | null;
    serverUri: string | null;
    error: FailureKind | "no-player" | null;
    status: number;
}

export interface Artwork {
    artUrl: string | null;
    dataUrl: string | null;
}

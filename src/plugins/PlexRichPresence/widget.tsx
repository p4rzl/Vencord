/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { React } from "@webpack/common";

import { elapsed, supportsCommand } from "./playback";
import type { Playback, PlayerCommand } from "./types";


export interface WidgetState {
    playback: Playback;
    artUrl: string | null;
}

let state: WidgetState | null = null;
const listeners = new Set<() => void>();

export function updateWidget(value: WidgetState | null) {
    state = value;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function formatTime(ms: number) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function Artwork({ url }: { url: string | null; }) {
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => { setFailed(false); }, [url]);
    return url && !failed
        ? <img className="prp-art" src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
        : <span className="prp-art prp-placeholder" aria-hidden="true">♫</span>;
}

export function PlayerWidget({ onCommand }: { onCommand: (command: PlayerCommand, params?: Record<string, string>) => void; }) {
    const value = React.useSyncExternalStore(subscribe, () => state);
    const [, rerender] = React.useState(0);
    const [seekPosition, setSeekPosition] = React.useState<number | null>(null);
    const seekTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => {
        setSeekPosition(null);
        return () => { if (seekTimer.current) clearTimeout(seekTimer.current); };
    }, [value?.playback.playerId, value?.playback.track.ratingKey]);
    React.useEffect(() => {
        if (!value?.playback.playing) return;
        const timer = setInterval(() => rerender(n => n + 1), 1000);
        return () => clearInterval(timer);
    }, [value?.playback.playing]);
    if (!value) return null;

    const { playback, artUrl } = value;
    const { track, playing, shuffle, repeat, control } = playback;
    const capabilities = control?.capabilities ?? [];
    const position = elapsed(playback);
    const duration = Math.max(0, Number(track.duration) || 0);
    const button = (label: string, icon: string, command: PlayerCommand, params?: Record<string, string>, active = false) => (
        <button
            type="button" title={label} aria-label={label}
            aria-pressed={command === "setParameters" ? active : undefined}
            className={active ? "prp-button prp-active" : "prp-button"}
            disabled={!supportsCommand(capabilities, command, params)}
            onClick={() => onCommand(command, params)}
        >{icon}</button>
    );
    return (
        <section className="prp-widget" aria-label="Plex playback">
            <div className="prp-row">
                <Artwork url={artUrl} />
                <div className="prp-meta">
                    <span className="prp-source" title={`${playback.playerName} · ${playback.source}`}>PLEX · {playback.playerName}</span>
                    <strong title={track.title}>{track.title || "Unknown track"}</strong>
                    <span>{track.originalTitle || track.grandparentTitle || "Unknown artist"}</span>
                    {track.parentTitle && <small>{track.parentTitle}</small>}
                </div>
            </div>
            <input
                className="prp-seek" type="range" aria-label="Seek" aria-valuetext={formatTime(position)}
                min={0} max={duration || 1} step={1000} value={seekPosition ?? position}
                disabled={!duration || !supportsCommand(capabilities, "seekTo")}
                onChange={event => {
                    const offset = Math.round(Number(event.target.value));
                    setSeekPosition(offset);
                    if (seekTimer.current) clearTimeout(seekTimer.current);
                    seekTimer.current = setTimeout(() => {
                        seekTimer.current = null;
                        onCommand("seekTo", { offset: String(offset) });
                        setSeekPosition(null);
                    }, 200);
                }}
            />
            <div className="prp-times"><span>{formatTime(position)}</span><span>{formatTime(duration)}</span></div>
            <div className="prp-controls">
                {button("Shuffle", "⤨", "setParameters", { shuffle: shuffle ? "0" : "1" }, shuffle)}
                {button("Previous", "⏮", "skipPrevious")}
                {button(playing ? "Pause" : "Play", playing ? "⏸" : "▶", playing ? "pause" : "play")}
                {button("Next", "⏭", "skipNext")}
                {button(repeat === 1 ? "Repeat one" : repeat === 2 ? "Repeat all" : "Repeat off", repeat === 1 ? "↻₁" : "↻", "setParameters", { repeat: repeat === 0 ? "2" : repeat === 2 ? "1" : "0" }, repeat !== 0)}
            </div>
        </section>
    );
}

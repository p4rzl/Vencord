/**
 * widget.tsx — Discord-native styled Plex playback controller.
 */

export interface WidgetState {
    title: string;
    artist: string;
    album: string;
    artUrl: string | null;
    durationMs: number;
    offsetMs: number;
    playing: boolean;
    shuffle: boolean;
    repeat: boolean;
    timestamp: number;
}

export interface WidgetCallbacks {
    onPlayPause: () => void;
    onNext: () => void;
    onPrevious: () => void;
    onShuffleToggle: () => void;
    onRepeatToggle: () => void;
    onSeek: (offsetMs: number) => void;
}

let container: HTMLDivElement | null = null;
let styleEl: HTMLStyleElement | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let observer: MutationObserver | null = null;
let lastState: WidgetState | null = null;

const STYLE = `
#prp-panel-widget {
    background: var(--background-secondary-alt, var(--background-secondary, #111214));
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    border-radius: 10px;
    margin: 6px 8px 8px;
    padding: 10px;
    display: none;
    flex-direction: column;
    gap: 9px;
    user-select: none;
    box-sizing: border-box;
    font-family: var(--font-primary, "gg sans", "Noto Sans", sans-serif);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.22);
    overflow: hidden;
}

#prp-panel-widget .prp-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
}

#prp-panel-widget .prp-art-wrapper {
    width: 54px;
    height: 54px;
    border-radius: 7px;
    overflow: hidden;
    flex: 0 0 54px;
    background: var(--background-tertiary, #1e1f22);
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 7px rgba(0, 0, 0, 0.22);
}

#prp-panel-widget img.prp-art {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    border-radius: inherit;
}

#prp-panel-widget .prp-art-fallback {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--interactive-muted, #6d6f78);
}

#prp-panel-widget .prp-meta {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    gap: 2px;
    flex: 1;
    min-width: 0;
}

#prp-panel-widget .prp-source {
    color: var(--text-muted, #949ba4);
    font-size: 10px;
    font-weight: 600;
    line-height: 1.1;
    text-transform: uppercase;
    letter-spacing: .04em;
}

#prp-panel-widget .prp-title {
    font-size: 13px;
    font-weight: 650;
    color: var(--header-primary, #f2f3f5);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.25;
}

#prp-panel-widget .prp-artist {
    font-size: 12px;
    color: var(--text-normal, #dbdee1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.2;
}

#prp-panel-widget .prp-album {
    font-size: 11px;
    color: var(--text-muted, #80848e);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.2;
}

#prp-panel-widget .prp-progress-container {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

#prp-panel-widget .prp-bar {
    height: 4px;
    border-radius: 999px;
    background: var(--background-modifier-accent, rgba(255, 255, 255, 0.16));
    cursor: pointer;
    position: relative;
}

#prp-panel-widget .prp-bar-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--brand-500, var(--brand-experiment, #5865f2));
    width: 0%;
    pointer-events: none;
    transition: width .08s linear;
}

#prp-panel-widget .prp-bar-handle {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--interactive-active, #fff);
    position: absolute;
    top: 50%;
    left: 0%;
    transform: translate(-50%, -50%);
    pointer-events: none;
    opacity: 0;
    transition: opacity .12s ease;
    box-shadow: 0 1px 4px rgba(0, 0, 0, .45);
}

#prp-panel-widget .prp-bar:hover .prp-bar-handle,
#prp-panel-widget .prp-bar:focus-within .prp-bar-handle {
    opacity: 1;
}

#prp-panel-widget .prp-times {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--text-muted, #949ba4);
    font-variant-numeric: tabular-nums;
}

#prp-panel-widget .prp-controls {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 7px;
    padding-top: 1px;
}

#prp-panel-widget .prp-btn {
    width: 28px;
    height: 28px;
    padding: 0;
    background: transparent;
    border: 0;
    color: var(--interactive-normal, #b5bac1);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    transition: color .12s ease, background-color .12s ease, transform .08s ease;
}

#prp-panel-widget .prp-btn:hover {
    color: var(--interactive-hover, #f2f3f5);
    background: var(--background-modifier-hover, rgba(255,255,255,.08));
}

#prp-panel-widget .prp-btn:active {
    transform: scale(.91);
}

#prp-panel-widget .prp-btn:focus-visible,
#prp-panel-widget .prp-bar:focus-visible {
    outline: 2px solid var(--brand-500, #5865f2);
    outline-offset: 2px;
}

#prp-panel-widget .prp-btn.prp-main {
    width: 34px;
    height: 34px;
    color: var(--header-primary, #fff);
    background: var(--background-modifier-accent, rgba(255,255,255,.12));
}

#prp-panel-widget .prp-btn.prp-main:hover {
    background: var(--background-modifier-hover, rgba(255,255,255,.18));
}

#prp-panel-widget .prp-btn.prp-active {
    color: var(--brand-500, var(--brand-experiment, #5865f2));
    background: color-mix(in srgb, var(--brand-500, #5865f2) 14%, transparent);
}
`;

function fmt(ms: number): string {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
}

function icon(name: "prev" | "play" | "pause" | "next" | "shuffle" | "repeat" | "music"): string {
    switch (name) {
        case "prev":
            return `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>`;
        case "next":
            return `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM6 6l8.5 6L6 18z"/></svg>`;
        case "play":
            return `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
        case "pause":
            return `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>`;
        case "shuffle":
            return `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.45 20 9.5V4h-5.5zm.33 9.42l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.12z"/></svg>`;
        case "repeat":
            return `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>`;
        case "music":
            return `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
    }
}

function attachToDiscordSidebar() {
    if (!container) return;
    const panels = document.querySelector("section[class*='panels_'], div[class*='panels_']");
    if (panels && container.parentElement !== panels) {
        const userBar = panels.querySelector("div[class*='container_']");
        if (userBar) {
            panels.insertBefore(container, userBar);
        } else {
            panels.appendChild(container);
        }
    }
}

export function mountWidget(cb: WidgetCallbacks) {
    if (container) return;

    styleEl = document.createElement("style");
    styleEl.textContent = STYLE;
    document.head.appendChild(styleEl);

    container = document.createElement("div");
    container.id = "prp-panel-widget";
    container.innerHTML = `
    <div class="prp-row">
    <div class="prp-art-wrapper">
    <img class="prp-art" alt="" decoding="async" loading="eager" referrerpolicy="no-referrer" style="display: none;" />
    <div class="prp-art-fallback">${icon("music")}</div>
    </div>
    <div class="prp-meta">
    <div class="prp-source">PLEX</div>
    <div class="prp-title"></div>
    <div class="prp-artist"></div>
    <div class="prp-album" style="display: none;"></div>
    </div>
    </div>
    <div class="prp-progress-container">
    <div class="prp-bar" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
    <div class="prp-bar-fill"></div>
    <div class="prp-bar-handle"></div>
    </div>
    <div class="prp-times">
    <span class="prp-elapsed">0:00</span>
    <span class="prp-duration">0:00</span>
    </div>
    </div>
    <div class="prp-controls">
    <button type="button" class="prp-btn prp-shuffle" aria-label="Shuffle" title="Shuffle">${icon("shuffle")}</button>
    <button type="button" class="prp-btn prp-prev" aria-label="Previous" title="Previous">${icon("prev")}</button>
    <button type="button" class="prp-btn prp-main prp-playpause" aria-label="Play/Pause" title="Play/Pause">${icon("play")}</button>
    <button type="button" class="prp-btn prp-next" aria-label="Next" title="Next">${icon("next")}</button>
    <button type="button" class="prp-btn prp-repeat" aria-label="Repeat" title="Repeat">${icon("repeat")}</button>
    </div>
    `;

    attachToDiscordSidebar();

    observer = new MutationObserver(() => attachToDiscordSidebar());
    observer.observe(document.body, { childList: true, subtree: true });

    container.querySelector(".prp-playpause")!.addEventListener("click", cb.onPlayPause);
    container.querySelector(".prp-next")!.addEventListener("click", cb.onNext);
    container.querySelector(".prp-prev")!.addEventListener("click", cb.onPrevious);
    container.querySelector(".prp-shuffle")!.addEventListener("click", cb.onShuffleToggle);
    container.querySelector(".prp-repeat")!.addEventListener("click", cb.onRepeatToggle);

    const bar = container.querySelector(".prp-bar") as HTMLDivElement;
    bar.addEventListener("click", (e: MouseEvent) => {
        if (!lastState || !lastState.durationMs) return;
        const rect = bar.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        const offset = Math.round(ratio * lastState.durationMs);
        cb.onSeek(offset);
        bar.setAttribute("aria-valuenow", String(offset));
    });

    bar.addEventListener("keydown", (e: KeyboardEvent) => {
        if (!lastState?.durationMs) return;
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const step = Math.max(5000, Math.round(lastState.durationMs * 0.05));
        const direction = e.key === "ArrowRight" ? 1 : -1;
        const offset = Math.min(lastState.durationMs, Math.max(0, lastState.offsetMs + direction * step));
        cb.onSeek(offset);
        bar.setAttribute("aria-valuenow", String(offset));
    });

    tickTimer = setInterval(() => {
        if (!lastState || !lastState.playing) return;
        renderProgress();
    }, 250);
}

export function unmountWidget() {
    if (tickTimer) clearInterval(tickTimer);
    if (observer) observer.disconnect();
    tickTimer = null;
    observer = null;
    container?.remove();
    styleEl?.remove();
    container = null;
    styleEl = null;
    lastState = null;
}

function renderProgress() {
    if (!container || !lastState) return;

    const now = Date.now();
    const elapsedMs = lastState.playing
    ? Math.min(lastState.durationMs, lastState.offsetMs + (now - lastState.timestamp))
    : lastState.offsetMs;

    const pct = lastState.durationMs ? Math.min(100, Math.max(0, (elapsedMs / lastState.durationMs) * 100)) : 0;

    (container.querySelector(".prp-bar-fill") as HTMLDivElement).style.width = `${pct}%`;
    (container.querySelector(".prp-bar-handle") as HTMLDivElement).style.left = `${pct}%`;
    (container.querySelector(".prp-elapsed") as HTMLElement).textContent = fmt(elapsedMs);
    const bar = container.querySelector(".prp-bar") as HTMLElement;
    bar.setAttribute("aria-valuemax", String(lastState.durationMs));
    bar.setAttribute("aria-valuenow", String(Math.round(elapsedMs)));
}

export function updateWidget(state: WidgetState | null) {
    if (!container) return;

    if (!state) {
        container.style.display = "none";
        lastState = null;
        return;
    }

    attachToDiscordSidebar();
    container.style.display = "flex";
    lastState = state;

    const titleEl = container.querySelector(".prp-title") as HTMLElement;
    const artistEl = container.querySelector(".prp-artist") as HTMLElement;
    titleEl.textContent = state.title;
    artistEl.textContent = state.artist;
    titleEl.title = state.title;
    artistEl.title = state.artist;

    const albumEl = container.querySelector(".prp-album") as HTMLElement;
    if (state.album && state.album.toLowerCase() !== state.artist.toLowerCase()) {
        albumEl.textContent = state.album;
        albumEl.style.display = "block";
    } else {
        albumEl.style.display = "none";
    }

    const artImg = container.querySelector(".prp-art") as HTMLImageElement;
    const artFallback = container.querySelector(".prp-art-fallback") as HTMLElement;

    // The controller receives a data: URL produced in the native process. This
    // avoids Discord renderer/CSP/network issues with Plex or temporary hosts.
    // Reset the element before every track change so a previous cover can never
    // remain visible when the new image fails.
    artImg.onload = () => {
        artImg.style.display = "block";
        artFallback.style.display = "none";
    };
    artImg.onerror = () => {
        artImg.style.display = "none";
        artFallback.style.display = "flex";
    };

    if (state.artUrl) {
        artImg.style.display = "none";
        artFallback.style.display = "flex";
        artImg.removeAttribute("src");
        artImg.src = state.artUrl;
        if (artImg.complete && artImg.naturalWidth > 0) {
            artImg.style.display = "block";
            artFallback.style.display = "none";
        }
    } else {
        artImg.removeAttribute("src");
        artImg.style.display = "none";
        artFallback.style.display = "flex";
    }

    (container.querySelector(".prp-duration") as HTMLElement).textContent = fmt(state.durationMs);
    renderProgress();

    const playBtn = container.querySelector(".prp-playpause") as HTMLButtonElement;
    playBtn.innerHTML = state.playing ? icon("pause") : icon("play");

    const shuffleBtn = container.querySelector(".prp-shuffle") as HTMLButtonElement;
    shuffleBtn.classList.toggle("prp-active", state.shuffle);

    const repeatBtn = container.querySelector(".prp-repeat") as HTMLButtonElement;
    repeatBtn.classList.toggle("prp-active", state.repeat);
}

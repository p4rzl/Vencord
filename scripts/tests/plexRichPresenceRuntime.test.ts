/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { build } from "esbuild";

import { normalizeResources } from "../../src/plugins/PlexRichPresence/plex";
import type { Playback } from "../../src/plugins/PlexRichPresence/types";

// Bundle the real plugin orchestrator; replace only its host (Discord/Vencord) interfaces.
const bundle = build({
    entryPoints: ["src/plugins/PlexRichPresence/index.tsx"], bundle: true, write: false, platform: "node", format: "cjs",
    define: { IS_WEB: "false" },
    plugins: [{
        name: "fake-discord-host",
        setup(builder) {
            builder.onResolve({ filter: /^@api\/Settings$|^@utils\/types$|^@components\/ErrorBoundary$|^@webpack\/common$|^\.\/widget$/ }, args => ({ path: args.path, namespace: "fake-host" }));
            builder.onLoad({ filter: /.*/, namespace: "fake-host" }, args => {
                const sources: Record<string, string> = {
                    "@api/Settings": `export function definePluginSettings(definitions) {
                        const store = Object.fromEntries(Object.entries(definitions).filter(([,d]) => "default" in d).map(([k,d]) => [k,d.default]));
                        Object.assign(store, globalThis.host.initialSettings);
                        return {store, definitions};
                    }`,
                    "@utils/types": "export default p => p; export const OptionType = {};",
                    "@components/ErrorBoundary": "export default () => null;",
                    "@webpack/common": `export const FluxDispatcher = {dispatch: event => globalThis.host.activities.push(event.activity)};
                        export const ApplicationAssetUtils = {fetchAssetIds: async (id, urls) => {globalThis.host.assetUrls.push(...urls); return ["registered-public-asset"]}};
                        export const Button = {}; export const Forms = {}; export const showToast = text => globalThis.host.toasts.push(text);`,
                    "./widget": "export const PlayerWidget = () => null; export const updateWidget = value => globalThis.host.widgets.push(value);"
                };
                return { contents: sources[args.path], loader: "js" };
            });
        }
    }]
});

const user = { id: "listener", title: "Listener", username: "listener", email: null, home: false };
const server = normalizeResources([{
    clientIdentifier: "server", name: "Shared server", owned: false, provides: "server", accessToken: "fixture-resource-token",
    connections: [{ uri: "https://remote.example", local: false, relay: false }]
}])[0];
const playing: Playback = {
    track: { type: "track", title: "Song", parentTitle: "Album", grandparentTitle: "Artist", ratingKey: "42", duration: 100_000, viewOffset: 10_000 },
    playing: true, shuffle: false, repeat: 0, observedAt: Date.now(), source: "sessions", serverUri: "https://remote.example",
    playerId: "player", playerName: "Plexamp", control: null
};

async function host(overrides: Record<string, unknown> = {}, initialSettings: Record<string, unknown> = {}) {
    const captured = {
        initialSettings: { plexToken: "fixture-account-token", showAlbumArt: false, ...initialSettings },
        activities: [] as any[], widgets: [] as any[], toasts: [] as string[], assetUrls: [] as string[]
    };
    const native = {
        resetContext: async () => {},
        fetchCurrentUser: async () => ({ ok: true, value: user }),
        discoverResources: async () => ({ ok: true, value: [server] }),
        fetchPlayback: async () => ({ playback: playing, serverUri: playing.serverUri, error: null, status: 200 }),
        ...overrides
    };
    const module = { exports: {} as any };
    const output = (await bundle).outputFiles[0].text;
    runInNewContext(output, {
        module, exports: module.exports, host: captured,
        VencordNative: { pluginHelpers: { PlexRichPresence: native } },
        setTimeout: () => 1, clearTimeout: () => {}, URL, URLSearchParams, TextDecoder,
        window: { prompt: () => null, alert: () => {} }
    });
    const plugin = module.exports.default;
    return { plugin, captured };
}

async function settle() {
    await new Promise<void>(resolve => setImmediate(resolve));
}

test("runtime retains login/server choice on a transient playback failure", async () => {
    const { plugin, captured } = await host({ fetchPlayback: async () => ({ playback: null, error: "network", status: 0 }) }, { selectedResourceId: "server" });
    plugin.start();
    await settle();
    assert.equal(plugin.settings.store.plexToken, "fixture-account-token");
    assert.equal(plugin.settings.store.selectedResourceId, "server");
    assert.ok(captured.toasts.some(t => t.includes("unreachable")));
    assert.equal(captured.toasts.some(t => t.includes("denied")), false);
    plugin.stop();
});

test("runtime cancels pending Discord updates on shutdown", async () => {
    let finish!: (value: unknown) => void;
    const { plugin, captured } = await host({ fetchPlayback: () => new Promise(resolve => { finish = resolve; }) });
    plugin.start();
    await settle();
    assert.ok(finish);
    plugin.stop();
    const count = captured.activities.length;
    finish({ playback: playing, error: null, status: 200 });
    await settle();
    assert.equal(captured.activities.length, count);
    assert.equal(captured.activities.at(-1), null);
});

test("runtime does not replace a missing saved Home profile with the owner", async () => {
    let playbackReads = 0;
    const { plugin } = await host({
        fetchHomeUsers: async () => ({ ok: true, value: [] }),
        fetchPlayback: async () => { playbackReads++; return { playback: playing, error: null, status: 200 }; }
    }, { homeUserId: "missing-child", homeUserTitle: "Child" });
    plugin.start();
    await settle();
    assert.equal(playbackReads, 0);
    assert.equal(plugin.settings.store.homeUserId, "missing-child");
    plugin.stop();
});

test("runtime migrates legacy main-account labels without requiring Plex Home", async () => {
    const { plugin, captured } = await host({ fetchHomeUsers: async () => { throw new Error("must not request Home"); } }, { homeUserTitle: "Listener" });
    plugin.start();
    await settle();
    assert.ok(captured.activities.some(a => a?.details === "Song"));
    assert.equal(plugin.settings.store.homeUserTitle, "");
    assert.equal(captured.assetUrls.length, 0, "disabled artwork performs no asset lookup");
    plugin.stop();
});

test("runtime never registers a private URL as a Discord image", async () => {
    const { plugin, captured } = await host({
        fetchOnlineCover: async () => ({ artUrl: "https://private.example/thumb?X-Plex-Token=fixture", dataUrl: "data:image/jpeg;base64,AQID" })
    }, { showAlbumArt: true });
    plugin.start();
    await settle();
    assert.equal(captured.assetUrls.length, 1);
    assert.match(captured.assetUrls[0], /^https:\/\/cdn\.jsdelivr\.net\//);
    assert.equal(captured.activities.at(-1)?.assets.large_image, "registered-public-asset");
    assert.ok(captured.activities.at(-1)?.application_id);
    plugin.stop();
});

test("runtime only discards an account login after an explicit authentication rejection", async () => {
    const transient = await host({ fetchCurrentUser: async () => ({ ok: false, kind: "network", status: 0 }) });
    transient.plugin.start();
    await settle();
    assert.equal(transient.plugin.settings.store.plexToken, "fixture-account-token");
    transient.plugin.stop();
    const expired = await host({ fetchCurrentUser: async () => ({ ok: false, kind: "unauthorized", status: 401 }) });
    expired.plugin.start();
    await settle();
    assert.equal(expired.plugin.settings.store.plexToken, "");
    expired.plugin.stop();
});

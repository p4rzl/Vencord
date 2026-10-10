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
    jsxFactory: "React.createElement", jsxFragment: "React.Fragment",
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
                        export const React = globalThis.host.react;
                        export const Button = {Colors: {RED: "red"}}; export const Forms = {}; export const Modal = {}; export const Select = {}; export const TextInput = {};
                        export const openModal = (render, options) => {const key = "fixture-modal-" + globalThis.host.modals.length; globalThis.host.modals.push({render, options, key}); return key};
                        export const closeModal = key => globalThis.host.modals.find(m => m.key === key)?.options?.onCloseCallback?.();
                        export const showToast = text => globalThis.host.toasts.push(text);`,
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
    const hooks: any[] = [];
    let hookIndex = 0;
    let renderedModal = -1;
    const captured = {
        initialSettings: { plexToken: "fixture-account-token", showAlbumArt: false, ...initialSettings },
        activities: [] as any[], widgets: [] as any[], toasts: [] as string[], assetUrls: [] as string[],
        modals: [] as any[], prompts: [] as string[],
        react: {
            createElement: (type: unknown, props: any, ...children: unknown[]) => ({ type, props: { ...props, children } }),
            useState: (initial: unknown) => {
                const index = hookIndex++;
                if (!(index in hooks)) hooks[index] = initial;
                return [hooks[index], (value: unknown) => { hooks[index] = value; }];
            }
        },
        renderModal: (index = captured.modals.length - 1): any => {
            if (index !== renderedModal) { hooks.length = 0; renderedModal = index; }
            hookIndex = 0;
            const modal = captured.modals[index];
            const element = modal.render({ transitionState: 1, onClose: () => modal.options?.onCloseCallback?.() });
            return typeof element.type === "function" ? element.type(element.props) : element;
        }
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
        module, exports: module.exports, host: captured, React: captured.react,
        VencordNative: { pluginHelpers: { PlexRichPresence: native } },
        setTimeout: () => 1, clearTimeout: () => {}, URL, URLSearchParams, TextDecoder,
        window: { prompt: (text: string) => { captured.prompts.push(text); throw new Error("prompt() is and will not be supported."); }, alert: () => {} }
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

for (const key of ["homeUserButton", "resourceButton", "playerButton"]) {
    test(`settings ${key} opens a Discord selector when Electron rejects prompt()`, async () => {
        const { plugin, captured } = await host({ fetchHomeUsers: async () => ({ ok: true, value: [{ id: "child", title: "Child", protected: false, restricted: true }] }) });
        plugin.start();
        await settle();
        plugin.settings.definitions[key].component().props.onClick();
        await settle();
        assert.equal(captured.modals.length, 1, "click must open a usable selector");
        assert.equal(captured.prompts.length, 0, "selectors must not depend on Electron prompt()");
        plugin.stop();
    });
}

function selectModal(captured: Awaited<ReturnType<typeof host>>["captured"], value: string) {
    const modal = captured.renderModal();
    modal.props.children[0].props.select(value);
    const updated = captured.renderModal();
    assert.equal(updated.props.actions[1].disabled, false);
    updated.props.actions[1].onClick();
}

test("Home selector unlocks the selected profile and uses its token/identity for playback", async () => {
    const contexts: Array<{ id: string; title: string; token: string; }> = [];
    const { plugin, captured } = await host({
        fetchHomeUsers: async () => ({ ok: true, value: [{ id: "child", title: "Child", protected: true, restricted: true }] }),
        switchHomeUser: async (token: string, id: string, pin: string) => {
            assert.equal(token, "fixture-account-token");
            assert.equal(id, "child");
            assert.equal(pin, "1234");
            return { ok: true, value: { token: "fixture-child-token" } };
        },
        fetchCurrentUser: async (token: string) => ({ ok: true, value: token === "fixture-child-token" ? { ...user, id: "child", title: "Child", username: null } : user }),
        fetchPlayback: async (_server: unknown, identity: any, token: string) => {
            contexts.push({ id: identity.id, title: identity.title, token });
            return { playback: playing, error: null, status: 200 };
        }
    });
    plugin.start();
    await settle();
    plugin.settings.definitions.homeUserButton.component().props.onClick();
    await settle();
    selectModal(captured, "child");
    await settle();
    assert.equal(captured.modals.length, 2, "protected profile must request its PIN in a second Discord modal");
    const pinModal = captured.renderModal();
    assert.equal(pinModal.props.children[0].props.type, "password");
    assert.equal(pinModal.props.actions[1].disabled, true);
    pinModal.props.children[0].props.onChange("1234");
    captured.renderModal().props.actions[1].onClick();
    await settle();
    assert.equal(plugin.settings.store.homeUserId, "child");
    assert.deepEqual(contexts.at(-1), { id: "child", title: "Child", token: "fixture-child-token" });
    assert.equal(JSON.stringify(plugin.settings.store).includes("1234"), false, "PIN must not be stored");
    assert.equal(captured.prompts.length, 0);
    plugin.stop();
});

test("canceling a selector retains settings and releases the setup lock", async () => {
    const { plugin, captured } = await host();
    plugin.start();
    await settle();
    plugin.settings.definitions.resourceButton.component().props.onClick();
    await settle();
    const before = plugin.settings.store.selectedResourceId;
    captured.renderModal().props.actions[0].onClick();
    await settle();
    assert.equal(plugin.settings.store.selectedResourceId, before);
    plugin.settings.definitions.playerButton.component().props.onClick();
    await settle();
    assert.equal(captured.modals.length, 2);
    selectModal(captured, "");
    await settle();
    assert.equal(plugin.settings.store.preferredPlayerId, "");
    plugin.stop();
});

test("server and player selectors apply identifiers rather than list positions", async () => {
    const secondServer = { ...server, clientIdentifier: "other-server", name: "Other server" };
    const player = { ...server, clientIdentifier: "my-player", provides: ["player"], owned: true, name: "Plexamp" };
    const { plugin, captured } = await host({ discoverResources: async () => ({ ok: true, value: [server, secondServer, player] }) });
    plugin.start();
    await settle();
    plugin.settings.definitions.resourceButton.component().props.onClick();
    await settle();
    selectModal(captured, "other-server");
    await settle();
    assert.equal(plugin.settings.store.selectedResourceId, "other-server");
    assert.equal(plugin.settings.store.selectedResourceName, "Other server");
    plugin.settings.definitions.playerButton.component().props.onClick();
    await settle();
    selectModal(captured, "my-player");
    await settle();
    assert.equal(plugin.settings.store.preferredPlayerId, "my-player");
    plugin.stop();
});

test("logout during profile selection cancels the modal without switching identities", async () => {
    let switches = 0;
    const { plugin, captured } = await host({
        fetchHomeUsers: async () => ({ ok: true, value: [{ id: "child", title: "Child", protected: false }] }),
        switchHomeUser: async () => { switches++; return { ok: true, value: { token: "fixture-child-token" } }; }
    });
    plugin.start();
    await settle();
    plugin.settings.definitions.homeUserButton.component().props.onClick();
    await settle();
    plugin.settings.definitions.logoutButton.component().props.onClick();
    await settle();
    assert.equal(plugin.settings.store.plexToken, "");
    assert.equal(switches, 0);
    assert.equal(captured.activities.at(-1), null);
    plugin.stop();
});

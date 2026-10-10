/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import * as Native from "../../src/plugins/PlexRichPresence/native";
import { catalogMatches, isPublicCoverUrl } from "../../src/plugins/PlexRichPresence/artwork";
import { activityData, PlaybackLifetime, selectSession, sessionMatchesUser, supportsCommand } from "../../src/plugins/PlexRichPresence/playback";
import { booleanValue, metadata, normalizeResources, request, safeBaseUrl, serverUrl } from "../../src/plugins/PlexRichPresence/plex";
import type { Playback, PlexCurrentUser, PlexResource } from "../../src/plugins/PlexRichPresence/types";

const originalFetch = globalThis.fetch;
afterEach(async () => { globalThis.fetch = originalFetch; await Native.resetContext(null); });

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

test("discovery preserves remote connections for a shared server", async () => {
    globalThis.fetch = async () => json([{
        clientIdentifier: "shared-server", provides: "server", owned: false,
        accessToken: "fixture-resource-token", name: "Shared library",
        connections: [
            { uri: "http://192.0.2.1:32400", protocol: "http", local: true, relay: false },
            { uri: "https://remote.example:32400", protocol: "https", local: false, relay: false },
            { uri: "https://relay.example", protocol: "https", local: false, relay: true }
        ]
    }]);
    const resources = await Native.fetchResources(null, "fixture-account-token");
    assert.equal(resources[0].owned, false);
    assert.equal(resources[0].connections.length, 3);
});

test("artwork never uploads private Plex images and returns a public catalog cover", async () => {
    const requests: string[] = [];
    globalThis.fetch = async (input, init) => {
        const url = String(input);
        requests.push(`${init?.method || "GET"} ${url}`);
        if (url.includes("itunes.apple.com")) return json({ results: [{
            artistName: "Fixture Artist", collectionName: "Fixture Album", trackName: "Fixture Song",
            artworkUrl100: "https://is1-ssl.mzstatic.com/image/100x100bb.jpg"
        }] });
        if (url.includes("tmpfiles")) return json({ status: "success", data: { url: "https://tmpfiles.org/fixture" } });
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } });
    };
    const result = await Native.fetchOnlineCover(null, "Fixture Artist", "Fixture Album", "Fixture Song", "https://private.example/thumb");
    assert.equal(requests.some(r => r.startsWith("POST")), false, "private artwork must not be uploaded");
    assert.match(result?.artUrl || "", /^https:\/\/is1-ssl\.mzstatic\.com\//);
    assert.match(result?.dataUrl || "", /^data:image\//);
});

test("server failures are distinguishable from access denial", async () => {
    globalThis.fetch = async () => json({}, 503);
    const result = await Native.fetchSessions(null, "https://server.example", "fixture-token");
    assert.equal(result.unauthorized, false);
    assert.equal(result.status, 503);
    assert.ok(result.error);
});

const user: PlexCurrentUser = { id: "global-id", title: "Listener", username: "listener", email: null, home: false };

function resource(id: string, provides: string, connections = ["https://remote.example"]): PlexResource {
    return normalizeResources([{
        clientIdentifier: id, provides, owned: provides === "player", name: id,
        accessToken: provides === "server" ? "fixture-resource-token" : "fixture-player-token",
        connections: connections.map(uri => ({ uri, local: uri.includes("192.0.2"), relay: false }))
    }])[0];
}

const track = {
    type: "track", ratingKey: "42", title: "Fixture Song", parentTitle: "Fixture Album", grandparentTitle: "Fixture Artist",
    duration: 200_000, viewOffset: 30_000, User: { id: "local-id", title: "Listener" },
    Player: { machineIdentifier: "my-player", state: "playing", title: "Plexamp" }
};

test("remote connection succeeds when the LAN connection fails", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input, init) => {
        const url = String(input);
        urls.push(url);
        assert.equal(new Headers(init?.headers).get("X-Plex-Token"), "fixture-resource-token");
        if (url.includes("192.0.2")) throw new Error("fixture unreachable");
        return json({ MediaContainer: { Metadata: [track] } });
    };
    const result = await Native.fetchPlayback(null, resource("server", "server", ["http://192.0.2.1:32400", "https://remote.example"]), user, "fixture-account-token", [], "");
    assert.equal(result.playback?.track.title, "Fixture Song");
    assert.equal(result.serverUri, "https://remote.example");
    assert.equal(result.error, null);
    assert.equal(urls.length, 2);
});

test("non-owner can use own Companion timeline without server session permission", async () => {
    const server = resource("server", "server");
    const player = resource("my-player", "player", ["http://player.example:32500"]);
    const commandIds: number[] = [];
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const token = new Headers(init?.headers).get("X-Plex-Token");
        if (url.pathname === "/status/sessions") return json({}, 403);
        if (url.pathname === "/player/timeline/poll") {
            assert.equal(token, "fixture-player-token");
            commandIds.push(Number(url.searchParams.get("commandID")));
            return new Response('<MediaContainer><Timeline type="music" state="playing" machineIdentifier="server" ratingKey="42" key="/library/metadata/42" time="30000" duration="200000" shuffle="1" repeat="2" controllable="playPause,skipNext,seekTo,shuffle,repeat" /></MediaContainer>');
        }
        if (url.pathname === "/library/metadata/42") {
            assert.equal(token, "fixture-resource-token");
            return json({ MediaContainer: { Metadata: [track] } });
        }
        if (url.pathname === "/player/playback/pause") {
            assert.equal(token, "fixture-player-token");
            assert.equal(new Headers(init?.headers).get("X-Plex-Target-Client-Identifier"), "my-player");
            commandIds.push(Number(url.searchParams.get("commandID")));
            return new Response(null, { status: 200 });
        }
        throw new Error("Unexpected fixture request");
    };
    const result = await Native.fetchPlayback(null, server, user, "fixture-account-token", [server, player], "my-player");
    assert.equal(result.playback?.source, "player");
    assert.equal(result.playback?.shuffle, true);
    assert.equal(result.playback?.repeat, 2);
    assert.equal(result.playback?.track.viewOffset, 30_000);
    assert.equal(result.error, null);
    const command = await Native.sendPlayerCommand(null, "my-player", "pause");
    assert.equal(command.ok, true);
    assert.ok(commandIds[1] > commandIds[0]);
    assert.equal((await Native.sendPlayerCommand(null, "my-player", "skipPrevious")).ok, false);
});

test("denied server sessions with no reachable player remains an explicit permission error", async () => {
    globalThis.fetch = async () => json({}, 403);
    const result = await Native.fetchPlayback(null, resource("server", "server"), user, "fixture-account-token", [], "");
    assert.equal(result.playback, null);
    assert.equal(result.error, "forbidden");
    assert.equal(result.status, 403);
});

test("session selection never falls back to the owner and honors player preference", () => {
    assert.equal(sessionMatchesUser({ ...track, User: { title: "Owner", id: "global-id" } }, user), false);
    assert.equal(sessionMatchesUser({ ...track, User: undefined }, user), false);
    assert.equal(sessionMatchesUser({ ...track, User: { id: "global-id" } }, user), false, "unverified PMS-local IDs cannot establish account identity");
    assert.equal(sessionMatchesUser(track, user), true, "account and PMS-local IDs may differ");
    assert.equal(selectSession([track], user, "other-player"), null);
    assert.equal(selectSession([{ ...track, Player: { ...track.Player, state: "stopped" } }], user, ""), null);
});

test("paused activities never claim that progress is advancing", () => {
    const playback: Playback = {
        track, playing: false, shuffle: false, repeat: 0, observedAt: 100_000,
        source: "sessions", serverUri: "https://remote.example", playerId: "my-player", playerName: "Plexamp", control: null
    };
    const paused = activityData(playback, "413407336082833418", undefined, 110_000);
    assert.equal("timestamps" in paused, false);
    assert.match(paused.state, /Paused/);
    const playing = activityData({ ...playback, playing: true }, "413407336082833418", "asset", 110_000);
    assert.deepEqual(playing.timestamps, { start: 70_000, end: 270_000 });
    assert.equal(playing.type, 2);
});

test("old asynchronous results cannot survive logout, profile change or restart", () => {
    const lifetime = new PlaybackLifetime();
    lifetime.start();
    const first = lifetime.begin()!;
    assert.equal(lifetime.begin(), null);
    lifetime.invalidate();
    assert.equal(lifetime.current(first), false);
    assert.equal(lifetime.begin(), null, "in-flight work retains the lock until finished");
    lifetime.end();
    const second = lifetime.begin()!;
    lifetime.stop();
    assert.equal(lifetime.current(second), false);
    lifetime.start();
    assert.equal(lifetime.current(second), false);
    lifetime.end();
    assert.notEqual(lifetime.begin(), null);
});

test("XML payloads decode entities, string booleans and nested session identity", () => {
    const resources = normalizeResources([{ clientIdentifier: "server", provides: "server", owned: "0", connections: [{ uri: "https://remote.example", local: "false", relay: "0" }] }]);
    assert.equal(resources[0].owned, false);
    assert.equal(resources[0].connections[0].local, false);
    assert.equal(booleanValue("false"), false);
    // Exercise XML decoding through the native transport, not an alternate parser in the test.
    assert.equal(metadata({ MediaContainer: {} })?.length, 0);
    assert.equal(metadata({ error: "unexpected" }), null);
});

test("Plex XML sessions preserve unicode and profile identity", async () => {
    globalThis.fetch = async () => new Response('<MediaContainer><Track type="track" title="Rock &amp; Roll &#xE8;" duration="200000"><User id="7" title="Listener"/><Player machineIdentifier="my-player" state="paused"/></Track></MediaContainer>');
    const result = await Native.fetchSessions(null, "https://remote.example", "fixture-token");
    assert.equal(result.sessions?.[0].title, "Rock & Roll è");
    assert.equal(result.sessions?.[0].Player.state, "paused");
    assert.equal(result.sessions?.[0].duration, 200_000);
});

test("artwork rejects wrong artists and non-public or credential-bearing URLs", () => {
    assert.equal(catalogMatches("Artist", "Album", "Song", { artist: "Someone else", album: "Album", title: "Song" }), false);
    assert.equal(catalogMatches("Artíst", "Album", "Song", { artist: "Artist", album: "Album", title: "Other Song" }), true);
    assert.equal(isPublicCoverUrl("https://private.example/thumb?X-Plex-Token=fixture"), false);
    assert.equal(isPublicCoverUrl("https://mzstatic.com.evil.example/cover.jpg"), false);
    assert.equal(isPublicCoverUrl("https://is1-ssl.mzstatic.com/image/cover.jpg"), true);
    assert.equal(safeBaseUrl("https://user:pass@example.com"), null);
    assert.throws(() => serverUrl("https://server.example", "//other.example/image"));
});

test("command capability checks respect shuffle/repeat and empty parameters", () => {
    assert.equal(supportsCommand(["playPause"], "pause"), true);
    assert.equal(supportsCommand(["shuffle"], "setParameters", { repeat: "2" }), false);
    assert.equal(supportsCommand(["shuffle"], "setParameters", {}), false);
});

test("request timeout covers stalled response bodies and errors contain no URLs/tokens", async () => {
    globalThis.fetch = async (_input, init) => new Response(new ReadableStream({
        start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(new Error("fixture secret must not escape")));
        }
    }));
    const result = await request("https://private.example", { headers: { "X-Plex-Token": "fixture" } }, 20);
    assert.deepEqual(result, { ok: false, kind: "network", status: 0 });
});

test("relay is tried after direct connections fail and the working URI is retained", async () => {
    const server = resource("server", "server", ["https://remote.example", "https://relay.example"]);
    server.connections[1].relay = true;
    const calls: string[] = [];
    globalThis.fetch = async input => {
        const url = String(input);
        calls.push(url);
        return url.includes("remote.example") ? json({}, 503) : json({ MediaContainer: { Metadata: [track] } });
    };
    const result = await Native.fetchPlayback(null, server, user, "fixture-account-token", [], "");
    assert.equal(result.serverUri, "https://relay.example");
    assert.equal(calls.length, 2);
    calls.length = 0;
    await Native.fetchPlayback(null, server, user, "fixture-account-token", [], "");
    assert.equal(calls.length, 1);
    assert.match(calls[0], /relay\.example/);
});

test("local Plexamp connection requires a matching owned player and probes without a token", async () => {
    const server = resource("server", "server");
    const player = resource("my-player", "player", []);
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/status/sessions") return json({}, 403);
        if (url.pathname === "/resources") {
            assert.equal(new Headers(init?.headers).get("X-Plex-Token"), null);
            return new Response('<MediaContainer><Player machineIdentifier="my-player" product="Plexamp" /></MediaContainer>');
        }
        if (url.pathname === "/player/timeline/poll") return new Response('<MediaContainer><Timeline type="music" state="paused" machineIdentifier="server" ratingKey="42" time="30000" controllable="playPause" /></MediaContainer>');
        return json({ MediaContainer: { Metadata: [track] } });
    };
    const result = await Native.fetchPlayback(null, server, user, "fixture-account-token", [server, player], "", "http://127.0.0.1:32500");
    assert.equal(result.playback?.source, "player");
    assert.equal(result.playback?.playing, false);
    assert.equal(result.playback?.control?.uri, "http://127.0.0.1:32500");
});

test("unknown local players are never attached or given credentials", async () => {
    const player = resource("my-player", "player", []);
    let timelineCalls = 0;
    globalThis.fetch = async input => {
        const url = new URL(String(input));
        if (url.pathname === "/status/sessions") return json({}, 403);
        if (url.pathname === "/resources") return new Response('<MediaContainer><Player machineIdentifier="owner-player" product="Plexamp" /></MediaContainer>');
        timelineCalls++;
        return json({});
    };
    const result = await Native.fetchPlayback(null, resource("server", "server"), user, "fixture-account-token", [player], "", "http://127.0.0.1:32500");
    assert.equal(result.playback, null);
    assert.equal(timelineCalls, 0);
});

test("a fast invalid local response does not hide a valid remote connection", async () => {
    globalThis.fetch = async input => String(input).includes("192.0.2")
        ? json({ unexpected: true })
        : json({ MediaContainer: { Metadata: [track] } });
    const result = await Native.fetchPlayback(null, resource("server", "server", ["http://192.0.2.1:32400", "https://remote.example"]), user, "fixture-token", [], "");
    assert.equal(result.serverUri, "https://remote.example");
    assert.equal(result.playback?.track.ratingKey, "42");
});

test("resetting context invalidates player command authorization", async () => {
    globalThis.fetch = async input => {
        const url = new URL(String(input));
        if (url.pathname === "/status/sessions") return json({}, 403);
        if (url.pathname === "/player/timeline/poll") return new Response('<MediaContainer><Timeline type="music" state="playing" machineIdentifier="server" ratingKey="42" controllable="playPause" /></MediaContainer>');
        return json({ MediaContainer: { Metadata: [track] } });
    };
    await Native.fetchPlayback(null, resource("server", "server"), user, "fixture-account", [resource("my-player", "player")], "");
    await Native.resetContext(null);
    const result = await Native.sendPlayerCommand(null, "my-player", "pause");
    assert.equal(result.ok, false);
});

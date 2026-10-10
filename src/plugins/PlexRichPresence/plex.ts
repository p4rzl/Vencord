/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PlexConnection, PlexResource, Result } from "./types";

export const CLIENT_IDENTIFIER = "vencord-plex-rich-presence";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export function plexHeaders(token?: string, extra: Record<string, string> = {}) {
    return {
        Accept: "application/json, application/xml;q=0.9",
        "X-Plex-Client-Identifier": CLIENT_IDENTIFIER,
        "X-Plex-Product": "Vencord Plex Rich Presence",
        "X-Plex-Version": "2.0",
        "X-Plex-Device": "Vencord",
        "X-Plex-Device-Name": "Vencord Plex Rich Presence",
        ...(token ? { "X-Plex-Token": token } : {}),
        ...extra
    };
}

export function booleanValue(value: unknown) {
    return value === true || value === 1 || value === "1" || value === "true";
}

export function list(value: unknown): string[] {
    return (Array.isArray(value) ? value : String(value ?? "").split(","))
        .map(v => String(v).trim().toLowerCase()).filter(Boolean);
}

export function safeBaseUrl(value: string): string | null {
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
        return url.href.replace(/\/$/, "");
    } catch {
        return null;
    }
}

export function serverUrl(base: string, path: string) {
    const origin = safeBaseUrl(base);
    if (!origin || !path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid Plex URL");
    const url = new URL(`${origin}${path}`);
    if (url.origin !== new URL(origin).origin) throw new Error("Invalid Plex path");
    return url.href;
}

// The timeout covers headers AND body consumption. Redirects cannot carry a Plex token to another host.
export async function request(url: string, init: RequestInit = {}, timeoutMs = 6000): Promise<Result<{ bytes: Uint8Array; contentType: string; }>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
        const res = await fetch(url, { ...init, signal, redirect: "error" });
        if (!res.ok) {
            await res.body?.cancel();
            return { ok: false, status: res.status, kind: res.status === 401 ? "unauthorized" : res.status === 403 ? "forbidden" : "http" };
        }
        if (Number(res.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
            await res.body?.cancel();
            return { ok: false, kind: "invalid", status: 200 };
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = res.body?.getReader();
        if (reader) {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.length;
                if (size > MAX_RESPONSE_BYTES) {
                    await reader.cancel();
                    return { ok: false, kind: "invalid", status: 200 };
                }
                chunks.push(value);
            }
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        return { ok: true, value: { bytes, contentType: res.headers.get("content-type") || "" } };
    } catch {
        return { ok: false, kind: "network", status: 0 };
    } finally {
        clearTimeout(timeout);
    }
}

interface XmlNode {
    tag: string;
    attrs: Record<string, string>;
    children: XmlNode[];
}

function decodeXml(value: string) {
    return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
        const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
        if (entity[0] !== "#") return named[entity] ?? match;
        const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    });
}

// Plex payloads use attributes for values; never expand external entities or a DTD.
export function xmlNodes(xml: string): XmlNode[] {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unsupported XML");
    const root: XmlNode = { tag: "root", attrs: {}, children: [] };
    const stack = [root];
    for (const [raw, close, tag, attributes, selfClose] of xml.matchAll(/<(\/)?([\w:-]+)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
        if (close) {
            if (stack.length < 2 || stack.pop()!.tag !== tag) throw new Error("Invalid XML");
            continue;
        }
        const attrs: Record<string, string> = {};
        for (const [, key, , value] of attributes.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) attrs[key] = decodeXml(value);
        const node: XmlNode = { tag, attrs, children: [] };
        stack[stack.length - 1].children.push(node);
        if (!selfClose && !raw.endsWith("/>")) stack.push(node);
    }
    if (stack.length !== 1 || root.children.length !== 1) throw new Error("Invalid XML");
    return root.children;
}

export async function requestData(url: string, init: RequestInit = {}): Promise<Result<any>> {
    const result = await request(url, init);
    if (!result.ok) return result;
    try {
        const text = new TextDecoder().decode(result.value.bytes).trim();
        if (!text) return { ok: false, kind: "invalid", status: 200 };
        return { ok: true, value: text.startsWith("<") ? xmlNodes(text) : JSON.parse(text) };
    } catch {
        return { ok: false, kind: "invalid", status: 200 };
    }
}

export function connectionOrder(connections: PlexConnection[], preferredUri?: string): PlexConnection[] {
    const score = (c: PlexConnection) => (c.uri === preferredUri ? 1000 : 0) + (c.relay ? 0 : 100) + (c.protocol === "https" ? 20 : 0) + (c.local ? 10 : 0);
    return [...connections].sort((a, b) => score(b) - score(a));
}

export function normalizeResources(data: any): PlexResource[] {
    const entries = Array.isArray(data) && data[0]?.tag
        ? data[0].children.filter((n: XmlNode) => n.tag === "Device").map((n: XmlNode) => ({ ...n.attrs, connections: n.children.filter(c => c.tag === "Connection").map(c => c.attrs) }))
        : Array.isArray(data) ? data : data?.resources ?? [];
    if (!Array.isArray(entries)) return [];
    return entries.filter(r => r?.clientIdentifier).map(r => {
        const connections: PlexConnection[] = (Array.isArray(r.connections) ? r.connections : []).flatMap((c: any) => {
            const uri = safeBaseUrl(String(c.uri ?? ""));
            return uri ? [{ uri, address: c.address ?? null, protocol: new URL(uri).protocol.slice(0, -1), local: booleanValue(c.local), relay: booleanValue(c.relay) }] : [];
        });
        return {
            clientIdentifier: String(r.clientIdentifier), name: String(r.name || r.product || "Plex"),
            owned: booleanValue(r.owned), ownerTitle: r.sourceTitle ?? null, accessToken: r.accessToken ?? null,
            provides: list(r.provides), capabilities: list(r.protocolCapabilities), connections,
            selectedConnection: connectionOrder(connections)[0] ?? null
        };
    });
}

export function metadata(data: any): any[] | null {
    if (Array.isArray(data) && data[0]?.tag === "MediaContainer") {
        return data[0].children.filter((n: XmlNode) => n.tag === "Track").map((n: XmlNode) => ({
            ...n.attrs,
            duration: Number(n.attrs.duration) || 0,
            viewOffset: Number(n.attrs.viewOffset) || 0,
            User: n.children.find(c => c.tag === "User")?.attrs,
            Player: n.children.find(c => c.tag === "Player")?.attrs
        }));
    }
    if (!data?.MediaContainer) return null;
    const entries = data.MediaContainer.Metadata;
    return entries == null ? [] : Array.isArray(entries) ? entries : null;
}

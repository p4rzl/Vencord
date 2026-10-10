/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import puppeteer from "puppeteer-core";

const executablePath = process.env.PLEX_TEST_BROWSER || ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(existsSync);

function luminance(rgb: string) {
    const [r, g, b] = rgb.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(n => {
        const value = n / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

for (const theme of ["dark", "light"] as const) {
    test(`controller text is readable with current Discord ${theme} theme variables`, { skip: !executablePath }, async () => {
        const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
        try {
            const page = await browser.newPage();
            await page.setViewport({ width: 340, height: 300 });
            const dark = theme === "dark";
            const background = dark ? "#2b2d31" : "#f2f3f5";
            const foreground = dark ? "#dbdee1" : "#313338";
            const muted = dark ? "#b5bac1" : "#4e5058";
            const styles = await readFile("src/plugins/PlexRichPresence/style.css", "utf8");
            await page.setContent(`<style>
                :root { --background-base-low: ${background}; --text-default: ${foreground}; --text-strong: ${foreground}; --text-muted: ${muted}; --interactive-icon-default: ${foreground}; }
                body { background: ${background}; color: black; font-family: sans-serif; margin: 0; }
                ${styles}
                </style><section class="prp-widget"><div class="prp-row">
                <span class="prp-art prp-placeholder">♫</span><div class="prp-meta">
                <span class="prp-source">PLEX · Plexamp</span><strong>A long track title that must not push text outside the panel</strong>
                <span>Artist</span><small>Album</small></div></div>
                <div class="prp-times"><span>0:30</span><span>3:20</span></div>
                <div class="prp-controls"><button class="prp-button">▶</button></div></section>`);
            const colors = await page.evaluate(() => Array.from(document.querySelectorAll(".prp-meta > *, .prp-times span, .prp-button")).map(node => ({
                label: node.textContent, color: getComputedStyle(node).color
            })));
            const backgroundLuminance = luminance(dark ? "rgb(43, 45, 49)" : "rgb(242, 243, 245)");
            for (const { color, label } of colors) {
                const textLuminance = luminance(color);
                const ratio = (Math.max(textLuminance, backgroundLuminance) + 0.05) / (Math.min(textLuminance, backgroundLuminance) + 0.05);
                assert.ok(ratio >= 4.5, `${label}: contrast ${ratio.toFixed(2)} is below 4.5:1 (${color})`);
            }
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
            assert.equal(overflow, false, "long track names must not expand the sidebar");
        } finally { await browser.close(); }
    });
}

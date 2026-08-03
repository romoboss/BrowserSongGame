import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const themeCss = await readFile(new URL("../theme.css", import.meta.url), "utf8");
const siteCss = await readFile(new URL("../site.css", import.meta.url), "utf8");

function colorValues(variableName) {
    return [...themeCss.matchAll(new RegExp(`${variableName}:\\s*(#[0-9a-f]{6})`, "gi"))]
        .map(match => match[1].toLowerCase());
}

test("all 18 themes provide unique Menu and Settings colors", () => {
    const menuColors = colorValues("--menu-button-color");
    const settingsColors = colorValues("--settings-button-color");

    assert.equal(menuColors.length, 18);
    assert.equal(settingsColors.length, 18);
    assert.equal(new Set(menuColors).size, 18);
    assert.equal(new Set(settingsColors).size, 18);
});

test("persistent controls consume their dedicated theme tokens and hard shadows", () => {
    assert.match(siteCss, /--toggle-fill:\s*var\(--menu-button-color\)/);
    assert.match(siteCss, /box-shadow:\s*3px 3px 0/);
    assert.match(themeCss, /--button-background:\s*var\(--settings-button-color\)/);
    assert.match(themeCss, /--outline-shadow:\s*3px 3px 0/);
});

test("the Settings close icon uses centered crossing strokes", () => {
    assert.match(themeCss, /\.settings-close-button\s*\{[^}]*display:\s*inline-grid;[^}]*place-items:\s*center;/s);
    assert.match(themeCss, /\.settings-close-icon::before[\s\S]*translate\(-50%, -50%\) rotate\(45deg\)/);
    assert.match(themeCss, /\.settings-close-icon::after[\s\S]*translate\(-50%, -50%\) rotate\(-45deg\)/);
});

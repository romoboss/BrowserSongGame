import assert from "node:assert/strict";
import test from "node:test";
import { FakeElement } from "./helpers.js";

const body = new FakeElement("body");
const preservedLink = new FakeElement("preserved-link");
const documentListeners = new Map();
const storedValues = new Map([
    ["music-link-theme", "black"],
    ["music-link-result-limit", "7"],
    ["music-link-ui-transparency", "30"],
    ["music-link-lucky-connections", "4"],
    ["music-link-lucky-linked-songs", "12"]
]);
preservedLink.setAttribute("href", "./index.html");
body.appendChild(preservedLink);

let replacedUrl = "";

globalThis.localStorage = {
    getItem: key => storedValues.get(key) ?? null,
    setItem: (key, value) => storedValues.set(key, String(value))
};
globalThis.document = {
    body,
    documentElement: {
        dataset: {},
        style: {
            setProperty(name, value) {
                this[name] = value;
            }
        }
    },
    readyState: "complete",
    createElement: () => new FakeElement(),
    getElementById: () => null,
    querySelectorAll: selector => selector === "a[data-preserve-theme]" ? [preservedLink] : [],
    addEventListener(type, listener) {
        documentListeners.set(type, listener);
    }
};
globalThis.location = {
    search: "?start=1&end=3&theme=dark-blue&limit=18&transparency=62",
    pathname: "/music/game.html",
    hash: "#route-data"
};
globalThis.history = {
    state: { test: true },
    replaceState(state, title, url) {
        assert.deepEqual(state, { test: true });
        assert.equal(title, "");
        replacedUrl = url;
    }
};

function findElement(root, predicate) {
    if (predicate(root)) return root;
    for (const child of root.children) {
        const match = findElement(child, predicate);
        if (match) return match;
    }
    return null;
}

await import("../settings.js");

test("settings migrates legacy URL values and stores all controls locally", () => {
    assert.equal(document.documentElement.dataset.theme, "dark-blue");
    assert.equal(document.documentElement.dataset.resultLimit, "18");
    assert.equal(document.documentElement.dataset.uiTransparency, "62");
    assert.equal(document.documentElement.dataset.luckyConnections, "4");
    assert.equal(document.documentElement.dataset.luckyLinkedSongs, "12");
    assert.equal(document.documentElement.style["--ui-panel-opacity"], "38%");
    assert.equal(storedValues.get("music-link-theme"), "dark-blue");
    assert.equal(storedValues.get("music-link-result-limit"), "18");
    assert.equal(storedValues.get("music-link-ui-transparency"), "62");
    assert.equal(storedValues.get("music-link-lucky-connections"), "4");
    assert.equal(storedValues.get("music-link-lucky-linked-songs"), "12");
    assert.equal(replacedUrl, "/music/game.html?start=1&end=3#route-data");
    assert.equal(preservedLink.getAttribute("href"), "./index.html");

    const launcher = findElement(body, element => element.id === "settings-button");
    const panel = findElement(body, element => element.id === "settings-panel");
    const closeButton = findElement(
        panel,
        element => String(element.className).includes("settings-close-button")
    );
    const closeIcon = findElement(
        panel,
        element => String(element.className).includes("settings-close-icon")
    );
    assert.ok(launcher);
    assert.ok(panel);
    assert.ok(closeButton);
    assert.ok(closeIcon);
    assert.equal(closeButton.getAttribute("aria-label"), "Close settings");
    assert.equal(closeIcon.getAttribute("aria-hidden"), "true");
    const launcherIcon = findElement(
        launcher,
        element => String(element.className).includes("settings-button-icon")
    );
    assert.deepEqual(
        [...launcherIcon.textContent].map(character => character.codePointAt(0)),
        [0x2699, 0xfe0e]
    );
    assert.equal(panel.hidden, true);

    launcher.dispatch("click");
    assert.equal(panel.hidden, false);

    const themeSelect = findElement(panel, element => element.id === "theme-select");
    assert.ok(themeSelect);
    assert.equal(themeSelect.value, "dark-blue");
    assert.equal(themeSelect.children.length, 3);
    assert.deepEqual(
        themeSelect.children.map(group => group.label),
        ["Neutral", "Light colors", "Dark colors"]
    );
    const themeOptions = themeSelect.children.flatMap(group => group.children);
    assert.equal(themeOptions.length, 18);
    assert.ok(themeOptions.some(option => option.value === "oled-black"));
    assert.equal(themeOptions.some(option => option.value === "midnight"), false);
    assert.equal(themeOptions.some(option => option.value === "deep-space"), false);

    themeSelect.value = "dark-purple";
    themeSelect.dispatch("change");
    assert.equal(document.documentElement.dataset.theme, "dark-purple");
    assert.equal(themeSelect.value, "dark-purple");
    assert.equal(storedValues.get("music-link-theme"), "dark-purple");
    assert.equal(preservedLink.getAttribute("href"), "./index.html");
    assert.ok(findElement(
        panel,
        element => String(element.className).includes("theme-swatch-dark-purple")
    ));

    const resultSlider = findElement(panel, element => element.id === "result-limit");
    assert.ok(resultSlider);
    assert.equal(resultSlider.min, "1");
    assert.equal(resultSlider.max, "25");
    assert.equal(resultSlider.value, "18");
    resultSlider.value = "25";
    resultSlider.dispatch("input");
    assert.equal(document.documentElement.dataset.resultLimit, "25");
    assert.equal(storedValues.get("music-link-result-limit"), "25");

    const transparencySlider = findElement(panel, element => element.id === "ui-transparency");
    assert.ok(transparencySlider);
    assert.equal(transparencySlider.min, "0");
    assert.equal(transparencySlider.max, "80");
    assert.equal(transparencySlider.value, "62");
    transparencySlider.value = "70";
    transparencySlider.dispatch("input");
    assert.equal(document.documentElement.dataset.uiTransparency, "70");
    assert.equal(document.documentElement.style["--ui-panel-opacity"], "30%");
    assert.equal(storedValues.get("music-link-ui-transparency"), "70");

    const luckySlider = findElement(panel, element => element.id === "lucky-connections");
    assert.ok(luckySlider);
    assert.equal(luckySlider.min, "1");
    assert.equal(luckySlider.max, "5");
    assert.equal(luckySlider.value, "4");
    assert.equal(luckySlider.attributes.get("aria-valuetext"), "4 connections");
    luckySlider.value = "1";
    luckySlider.dispatch("input");
    assert.equal(document.documentElement.dataset.luckyConnections, "1");
    assert.equal(storedValues.get("music-link-lucky-connections"), "1");
    assert.equal(luckySlider.attributes.get("aria-valuetext"), "1 connection");

    const linkedSongsSlider = findElement(panel, element => element.id === "lucky-linked-songs");
    assert.ok(linkedSongsSlider);
    assert.equal(linkedSongsSlider.min, "5");
    assert.equal(linkedSongsSlider.max, "75");
    assert.equal(linkedSongsSlider.value, "12");
    assert.equal(linkedSongsSlider.attributes.get("aria-valuetext"), "12 linked songs");
    linkedSongsSlider.value = "5";
    linkedSongsSlider.dispatch("input");
    assert.equal(document.documentElement.dataset.luckyLinkedSongs, "5");
    assert.equal(storedValues.get("music-link-lucky-linked-songs"), "5");
    assert.equal(linkedSongsSlider.attributes.get("aria-valuetext"), "5 linked songs");

    const futureSection = findElement(
        panel,
        element => String(element.className).includes("settings-future")
    );
    assert.ok(futureSection, "Expected reserved space for future settings");
});

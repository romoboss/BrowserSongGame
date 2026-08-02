import assert from "node:assert/strict";
import test from "node:test";
import { FakeElement } from "./helpers.js";

const body = new FakeElement("body");
const preservedLink = new FakeElement("preserved-link");
const documentListeners = new Map();
const storedValues = new Map([
    ["music-link-theme", "black"],
    ["music-link-result-limit", "7"],
    ["music-link-ui-transparency", "30"]
]);
preservedLink.setAttribute("href", "./index.html");
body.appendChild(preservedLink);

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
globalThis.location = { search: "?theme=dark-blue&limit=18&transparency=62" };

function findElement(root, predicate) {
    if (predicate(root)) return root;
    for (const child of root.children) {
        const match = findElement(child, predicate);
        if (match) return match;
    }
    return null;
}

function findElements(root, predicate, matches = []) {
    if (predicate(root)) matches.push(root);
    for (const child of root.children) findElements(child, predicate, matches);
    return matches;
}

await import("../settings.js");

test("settings loads, applies, and stores appearance themes", () => {
    assert.equal(document.documentElement.dataset.theme, "dark-blue");
    assert.equal(document.documentElement.dataset.resultLimit, "18");
    assert.equal(document.documentElement.dataset.uiTransparency, "62");
    assert.equal(document.documentElement.style["--ui-panel-opacity"], "38%");
    assert.equal(
        preservedLink.getAttribute("href"),
        "./index.html?theme=dark-blue&limit=18&transparency=62"
    );

    const launcher = findElement(body, element => element.id === "settings-button");
    const panel = findElement(body, element => element.id === "settings-panel");
    assert.ok(launcher);
    assert.ok(panel);
    assert.equal(panel.hidden, true);

    launcher.dispatch("click");
    assert.equal(panel.hidden, false);

    const darkPurpleOption = findElement(
        panel,
        element => element.dataset.theme === "dark-purple"
    );
    assert.ok(darkPurpleOption);
    assert.ok(findElement(panel, element => element.dataset.theme === "oled-black"));
    assert.equal(findElement(panel, element => element.dataset.theme === "midnight"), null);
    assert.equal(findElement(panel, element => element.dataset.theme === "deep-space"), null);
    assert.equal(
        findElements(panel, element => Boolean(element.dataset.theme)).length,
        18
    );
    darkPurpleOption.dispatch("click");
    assert.equal(document.documentElement.dataset.theme, "dark-purple");
    assert.equal(storedValues.get("music-link-theme"), "dark-purple");
    assert.equal(
        preservedLink.getAttribute("href"),
        "./index.html?theme=dark-purple&limit=18&transparency=62"
    );
    assert.equal(darkPurpleOption.attributes.get("aria-pressed"), "true");

    const resultSlider = findElement(panel, element => element.id === "result-limit");
    assert.ok(resultSlider);
    assert.equal(resultSlider.min, "1");
    assert.equal(resultSlider.max, "25");
    assert.equal(resultSlider.value, "18");
    resultSlider.value = "25";
    resultSlider.dispatch("input");
    assert.equal(document.documentElement.dataset.resultLimit, "25");
    assert.equal(storedValues.get("music-link-result-limit"), "25");
    assert.equal(
        preservedLink.getAttribute("href"),
        "./index.html?theme=dark-purple&limit=25&transparency=62"
    );

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
    assert.equal(
        preservedLink.getAttribute("href"),
        "./index.html?theme=dark-purple&limit=25&transparency=70"
    );

    const futureSection = findElement(
        panel,
        element => String(element.className).includes("settings-future")
    );
    assert.ok(futureSection, "Expected reserved space for future settings");
});

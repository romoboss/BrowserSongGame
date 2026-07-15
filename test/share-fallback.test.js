import assert from "node:assert/strict";
import test from "node:test";
import { createDatabaseFixture, installFakeDocument } from "./helpers.js";

const elements = installFakeDocument([
    "challenge-form",
    "start-input",
    "start-suggestions",
    "end-input",
    "end-suggestions",
    "start-game",
    "lucky-button",
    "share-link",
    "setup-status"
]);
elements["start-suggestions"].hidden = true;
elements["end-suggestions"].hidden = true;
globalThis.SONG_DATABASE = createDatabaseFixture();
globalThis.location = { href: "https://example.com/music/index.html" };
Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {}
});

let fallbackCopiedText = "";
document.execCommand = command => {
    const textarea = document.body.children.find(element => element.selected);
    fallbackCopiedText = textarea?.value || "";
    return command === "copy" && Boolean(textarea);
};

await import("../setup.js");

test("share link falls back when the Clipboard API is unavailable", async () => {
    elements["start-input"].value = "Start";
    elements["start-input"].dispatch("input");
    elements["start-suggestions"].children
        .find(element => element.dataset.artistId === "1")
        .dispatch("click");

    elements["end-input"].value = "Target";
    elements["end-input"].dispatch("input");
    elements["end-suggestions"].children
        .find(element => element.dataset.artistId === "3")
        .dispatch("click");

    document.documentElement.dataset.theme = "dark-blue";
    await elements["share-link"].dispatch("click");

    const copiedUrl = new URL(fallbackCopiedText);
    assert.equal(copiedUrl.href, "https://example.com/music/game.html?start=1&end=3");
    assert.equal(elements["setup-status"].textContent, "Challenge link copied to your clipboard.");
    assert.equal(document.body.children.length, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { FakeElement, installFakeDocument } from "./helpers.js";

const elements = installFakeDocument([
    "challenge-form",
    "start-input",
    "start-suggestions",
    "end-input",
    "end-suggestions",
    "start-game",
    "lucky-button",
    "swap-artists",
    "share-link",
    "setup-status"
]);
globalThis.location = { href: "https://example.com/route-picker" };
globalThis.SONG_ROUTE_DATABASE = {
    graphVersion: "lazy-fixture",
    records: [
        [1, "Lucky Start", 25, 0],
        [2, "Lucky Bridge", 2, 0],
        [3, "Lucky End", 25, 0]
    ],
    terminalAdjacency: [],
    componentSizes: [3]
};

const adjacency = [];
adjacency[1] = [2];
adjacency[2] = [1, 3];
adjacency[3] = [2];
const appendedElements = [];
document.head = new FakeElement("head");
document.head.appendChild = element => {
    appendedElements.push(element);
    element.parentNode = document.head;
    if (element.src) {
        globalThis.SONG_ROUTE_GRAPH = { version: "lazy-fixture", adjacency };
        queueMicrotask(() => element.dispatch("load"));
    }
};

await import("../js/setup.js");

test("Lucky loads the split route graph on demand after a low-priority prefetch", async () => {
    const prefetch = appendedElements.find(element => element.rel === "prefetch");
    assert.ok(prefetch);
    assert.match(prefetch.href, /route-graph\.js\?v=lazy-fixture$/);

    await elements["lucky-button"].dispatch("click");

    const graphScript = appendedElements.find(element => element.src);
    assert.ok(graphScript);
    assert.match(graphScript.src, /route-graph\.js\?v=lazy-fixture$/);
    assert.equal(elements["lucky-button"].disabled, false);
    assert.match(elements["setup-status"].textContent, /2 connections apart and ready to play\.$/);

    const startId = elements["start-input"].dataset.artistId;
    const endId = elements["end-input"].dataset.artistId;
    const startName = elements["start-input"].value;
    const endName = elements["end-input"].value;
    await elements["start-input"].dispatch("focus");
    await elements["end-input"].dispatch("focus");
    assert.equal(elements["start-input"].dataset.artistId, startId);
    assert.equal(elements["end-input"].dataset.artistId, endId);
    assert.equal(elements["start-input"].value, startName);
    assert.equal(elements["end-input"].value, endName);
    assert.equal(elements["start-suggestions"].hidden, true);
    assert.equal(elements["end-suggestions"].hidden, true);
    assert.equal(elements["swap-artists"].disabled, false);
});

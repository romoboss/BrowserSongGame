import assert from "node:assert/strict";
import test from "node:test";
import { installFakeDocument } from "./helpers.js";

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
elements["start-suggestions"].hidden = true;
elements["end-suggestions"].hidden = true;

const adjacency = [];
for (let id = 1; id <= 7; id += 1) adjacency[id] = [];
for (const id of [1, 2, 3, 4, 5]) {
    adjacency[id] = [1, 2, 3, 4, 5].filter(candidate => candidate !== id);
}
adjacency[6] = [7];
adjacency[7] = [6];

globalThis.SONG_ROUTE_DATABASE = {
    graphVersion: "fixture-1",
    records: [
        [4, "Zalpha", 3, 0],
        [3, "Alphabet", 4, 0],
        [1, "The Alpha", 5, 0],
        [5, "Álpha", 2, 0],
        [2, "Alpha", 6, 0],
        [6, "Solo One", 1, null],
        [7, "Solo Two", 1, null]
    ],
    terminalAdjacency: Object.assign([], { 6: [7], 7: [6] }),
    componentSizes: [5]
};
globalThis.SONG_ROUTE_GRAPH = { version: "fixture-1", adjacency };
globalThis.location = { href: "https://example.com/route-picker" };

let scheduledCallback = null;
let frameRequests = 0;
globalThis.requestAnimationFrame = callback => {
    frameRequests += 1;
    scheduledCallback = callback;
    return frameRequests;
};
globalThis.cancelAnimationFrame = () => {
    scheduledCallback = null;
};

await import("../js/setup.js");

function runScheduledSearch() {
    const callback = scheduledCallback;
    scheduledCallback = null;
    callback?.();
}

test("route-picker index coalesces input and preserves exact, prefix, and alphabetical ranking", () => {
    elements["start-input"].value = "a";
    elements["start-input"].dispatch("input");
    elements["start-input"].value = "alpha";
    elements["start-input"].dispatch("input");

    assert.equal(frameRequests, 1);
    assert.equal(elements["start-suggestions"].children.length, 0);
    runScheduledSearch();

    assert.deepEqual(
        elements["start-suggestions"].children.map(element => element.dataset.artistId),
        ["2", "5", "3", "1", "4"]
    );

    const originalElements = [...elements["start-suggestions"].children];
    elements["start-input"].value = " alpha ";
    elements["start-input"].dispatch("input");
    runScheduledSearch();
    assert.deepEqual(elements["start-suggestions"].children, originalElements);
});

test("component metadata and terminal adjacency preserve reachable end filtering", () => {
    elements["start-input"].value = "Solo One";
    elements["start-input"].dispatch("input");
    runScheduledSearch();
    const soloOne = elements["start-suggestions"].children[0];
    elements["start-suggestions"].dispatch("click", { target: soloOne });

    assert.equal(elements["end-input"].disabled, false);
    elements["end-input"].value = "Solo";
    elements["end-input"].dispatch("input");
    runScheduledSearch();
    assert.deepEqual(
        elements["end-suggestions"].children.map(element => element.dataset.artistId),
        ["7"]
    );

    const soloTwo = elements["end-suggestions"].children[0];
    elements["end-suggestions"].dispatch("click", { target: soloTwo });
    elements["swap-artists"].dispatch("click");
    assert.equal(elements["start-input"].dataset.artistId, "7");
    assert.equal(elements["end-input"].dataset.artistId, "6");
    assert.equal(elements["swap-artists"].disabled, false);
});

test("the preloaded compact graph keeps Lucky generation synchronous", () => {
    document.documentElement.dataset.luckyConnections = "1";
    document.documentElement.dataset.luckyLinkedSongs = "2";
    elements["lucky-button"].dispatch("click");

    assert.match(elements["setup-status"].textContent, /1 connection apart and ready to play\.$/);
    assert.equal(elements["lucky-button"].disabled, false);

    const startId = elements["start-input"].dataset.artistId;
    const endId = elements["end-input"].dataset.artistId;
    const startName = elements["start-input"].value;
    const endName = elements["end-input"].value;
    elements["start-input"].dispatch("focus");
    elements["end-input"].dispatch("focus");
    runScheduledSearch();
    assert.equal(elements["start-input"].dataset.artistId, startId);
    assert.equal(elements["end-input"].dataset.artistId, endId);
    assert.equal(elements["start-input"].value, startName);
    assert.equal(elements["end-input"].value, endName);
    assert.equal(elements["start-suggestions"].hidden, true);
    assert.equal(elements["end-suggestions"].hidden, true);
});

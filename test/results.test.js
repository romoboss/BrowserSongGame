import assert from "node:assert/strict";
import test from "node:test";
import { createDatabaseFixture, installFakeDocument } from "./helpers.js";

const elements = installFakeDocument([
    "challenge-summary",
    "results-content",
    "time-stat",
    "move-stat",
    "artist-stat",
    "unique-stat",
    "route-list",
    "replay-link",
    "results-error",
    "results-error-message"
]);
elements["results-content"].hidden = true;
elements["results-error"].hidden = true;
document.documentElement.dataset.theme = "pink";
globalThis.SONG_DATABASE = createDatabaseFixture();
globalThis.location = {
    hash: "#v=1&start=1&end=3&elapsed=65000&route=1%7C100%3A2%7C101%3A3"
};

await import("../results.js");

test("results validates and renders route statistics", () => {
    assert.equal(elements["results-content"].hidden, false);
    assert.equal(elements["results-error"].hidden, true);
    assert.equal(elements["challenge-summary"].textContent, "Start Artist to Target Artist");
    assert.equal(elements["time-stat"].textContent, "1m 5s");
    assert.equal(elements["move-stat"].textContent, "2");
    assert.equal(elements["artist-stat"].textContent, "3");
    assert.equal(elements["unique-stat"].textContent, "3");
    assert.equal(elements["route-list"].children.length, 3);
    assert.equal(elements["replay-link"].href, "./game.html?start=1&end=3&theme=pink&limit=10");
});

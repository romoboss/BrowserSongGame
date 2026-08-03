import assert from "node:assert/strict";
import test from "node:test";
import { createDatabaseFixture, installFakeDocument } from "./helpers.js";

const elements = installFakeDocument([
    "results-kicker",
    "challenge-summary",
    "results-content",
    "daily-result-note",
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
elements["daily-result-note"].hidden = true;
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
    assert.equal(
        elements["replay-link"].href,
        "./game.html?start=1&end=3"
    );

    const [startStep, middleStep, finishStep] = elements["route-list"].children;
    assert.equal(startStep.classList.contains("route-step"), true);
    assert.equal(startStep.classList.contains("is-start"), true);
    assert.equal(startStep.children[0].classList.contains("route-node"), true);
    assert.deepEqual(
        startStep.children[0].children.map(child => child.textContent),
        ["Start", "Start Artist", "Starting artist"]
    );
    assert.deepEqual(
        middleStep.children[0].children.map(child => child.textContent),
        ["Move 1", "Middle Artist", "via Bridge One"]
    );
    assert.equal(finishStep.classList.contains("is-finish"), true);
    assert.deepEqual(
        finishStep.children[0].children.map(child => child.textContent),
        ["Finish", "Target Artist", "via Final Link"]
    );
});

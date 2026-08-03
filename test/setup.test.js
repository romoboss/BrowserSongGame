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
globalThis.location = { href: "file:///D:/BrowserDailyGame/route-picker.html" };
let copiedLink = "";
Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
        clipboard: {
            writeText: async value => { copiedLink = value; }
        }
    }
});

await import("../setup.js");

test("setup selects a reachable pair, shares it, and starts the challenge", async () => {
    assert.equal(elements["end-input"].disabled, true);

    elements["start-input"].value = "Start";
    elements["start-input"].dispatch("input");
    const startSuggestion = elements["start-suggestions"].children.find(
        element => element.dataset.artistId === "1"
    );
    assert.ok(startSuggestion);
    startSuggestion.dispatch("click");
    assert.equal(elements["end-input"].disabled, false);

    elements["end-input"].value = "Dead";
    elements["end-input"].dispatch("input");
    assert.ok(
        elements["end-suggestions"].children.some(element => element.dataset.artistId === "4"),
        "Expected a one-song artist to be available as an end target"
    );

    elements["end-input"].value = "Target";
    elements["end-input"].dispatch("input");
    const endSuggestion = elements["end-suggestions"].children.find(
        element => element.dataset.artistId === "3"
    );
    assert.ok(endSuggestion);
    endSuggestion.dispatch("click");
    assert.equal(elements["start-game"].disabled, false);

    document.documentElement.dataset.luckyConnections = "1";
    document.documentElement.dataset.luckyLinkedSongs = "10";
    elements["lucky-button"].dispatch("click");
    assert.equal(
        elements["setup-status"].textContent,
        "No eligible random challenge with 1 connection and at least 10 linked songs per artist was found."
    );
    assert.equal(elements["setup-status"].dataset.error, "true");

    document.documentElement.dataset.luckyConnections = "2";
    document.documentElement.dataset.luckyLinkedSongs = "26";
    elements["lucky-button"].dispatch("click");
    assert.equal(
        elements["setup-status"].textContent,
        "No eligible random challenge with 2 connections and at least 26 linked songs per artist was found."
    );

    document.documentElement.dataset.luckyLinkedSongs = "10";
    elements["lucky-button"].dispatch("click");
    const startId = elements["start-input"].dataset.artistId;
    const endId = elements["end-input"].dataset.artistId;
    const database = globalThis.SONG_DATABASE;
    const sharedSongs = database.artistSongs[startId]
        .filter(songId => database.artistSongs[endId].includes(songId));

    assert.ok(database.artistSongs[startId].length >= 10);
    assert.ok(database.artistSongs[endId].length >= 10);
    assert.deepEqual(sharedSongs, []);
    assert.deepEqual(new Set([startId, endId]), new Set(["1", "3"]));
    assert.match(elements["setup-status"].textContent, /2 connections apart and ready to play\.$/);
    assert.equal(elements["setup-status"].dataset.error, "false");

    document.documentElement.dataset.theme = "purple";
    assert.equal(elements["share-link"].disabled, false);
    await elements["share-link"].dispatch("click");

    const sharedUrl = new URL(copiedLink);
    assert.equal(sharedUrl.origin, "https://songaveler.romoboss.com");
    assert.match(sharedUrl.pathname, /\/game$/);
    assert.equal(sharedUrl.searchParams.get("start"), startId);
    assert.equal(sharedUrl.searchParams.get("end"), endId);
    assert.equal(sharedUrl.searchParams.has("theme"), false);
    assert.equal(sharedUrl.searchParams.has("limit"), false);
    assert.equal(
        elements["setup-status"].textContent,
        "Challenge link copied to your clipboard."
    );

    let prevented = false;
    elements["challenge-form"].dispatch("submit", {
        preventDefault: () => { prevented = true; }
    });
    assert.equal(prevented, true);
    assert.match(
        globalThis.location.href,
        /^\.\/game\?start=[13]&end=[13]$/
    );
    assert.notEqual(startId, endId);
});

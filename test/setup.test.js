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
globalThis.location = { href: "file:///D:/BrowserDailyGame/index.html" };
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

    elements["lucky-button"].dispatch("click");
    const startId = elements["start-input"].dataset.artistId;
    const endId = elements["end-input"].dataset.artistId;
    const database = globalThis.SONG_DATABASE;
    const sharedSongs = database.artistSongs[startId]
        .filter(songId => database.artistSongs[endId].includes(songId));

    assert.ok(database.artistSongs[startId].length >= 10);
    assert.ok(database.artistSongs[endId].length >= 10);
    assert.deepEqual(sharedSongs, []);

    document.documentElement.dataset.theme = "purple";
    assert.equal(elements["share-link"].disabled, false);
    await elements["share-link"].dispatch("click");

    const sharedUrl = new URL(copiedLink);
    assert.equal(sharedUrl.protocol, "file:");
    assert.match(sharedUrl.pathname, /\/game\.html$/);
    assert.equal(sharedUrl.searchParams.get("start"), startId);
    assert.equal(sharedUrl.searchParams.get("end"), endId);
    assert.equal(sharedUrl.searchParams.has("theme"), false);
    assert.equal(sharedUrl.searchParams.has("limit"), false);
    assert.equal(
        elements["setup-status"].textContent,
        "Local challenge link copied. It will only work on this computer."
    );

    let prevented = false;
    elements["challenge-form"].dispatch("submit", {
        preventDefault: () => { prevented = true; }
    });
    assert.equal(prevented, true);
    assert.match(
        globalThis.location.href,
        /^\.\/game\.html\?start=[13]&end=[13]&theme=purple&limit=10&transparency=48$/
    );
    assert.notEqual(startId, endId);
});

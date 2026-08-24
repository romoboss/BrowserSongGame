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
    "swap-artists",
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

await import("../js/setup.js");

test("setup selects a reachable pair, shares it, and starts the challenge", async () => {
    assert.equal(elements["end-input"].disabled, true);
    assert.equal(elements["swap-artists"].disabled, true);

    elements["start-input"].value = "Start";
    elements["start-input"].dispatch("input");
    const startSuggestion = elements["start-suggestions"].children.find(
        element => element.dataset.artistId === "1"
    );
    assert.ok(startSuggestion);
    elements["start-suggestions"].dispatch("click", { target: startSuggestion });
    assert.equal(elements["end-input"].disabled, false);
    assert.equal(elements["swap-artists"].disabled, true);

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
    elements["end-suggestions"].dispatch("click", { target: endSuggestion });
    assert.equal(elements["start-game"].disabled, false);
    assert.equal(elements["swap-artists"].disabled, false);

    await elements["swap-artists"].dispatch("click");
    assert.equal(elements["start-input"].dataset.artistId, "3");
    assert.equal(elements["start-input"].value, "Target Artist");
    assert.equal(elements["end-input"].dataset.artistId, "1");
    assert.equal(elements["end-input"].value, "Start Artist");
    assert.equal(elements["setup-status"].textContent, "Target Artist to Start Artist. Ready to play.");

    let swapSubmitPrevented = false;
    elements["challenge-form"].dispatch("submit", {
        preventDefault: () => { swapSubmitPrevented = true; }
    });
    assert.equal(swapSubmitPrevented, true);
    assert.equal(globalThis.location.href, "./game?start=3&end=1");

    await elements["swap-artists"].dispatch("click");
    assert.equal(elements["start-input"].dataset.artistId, "1");
    assert.equal(elements["end-input"].dataset.artistId, "3");

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
    const startName = elements["start-input"].value;
    const endName = elements["end-input"].value;
    const database = globalThis.SONG_DATABASE;
    const sharedSongs = database.artistSongs[startId]
        .filter(songId => database.artistSongs[endId].includes(songId));

    assert.ok(database.artistSongs[startId].length >= 10);
    assert.ok(database.artistSongs[endId].length >= 10);
    assert.deepEqual(sharedSongs, []);
    assert.deepEqual(new Set([startId, endId]), new Set(["1", "3"]));
    assert.match(elements["setup-status"].textContent, /2 connections apart and ready to play\.$/);
    assert.equal(elements["setup-status"].dataset.error, "false");

    await elements["start-input"].dispatch("focus");
    await elements["end-input"].dispatch("focus");
    assert.equal(elements["start-input"].value, startName);
    assert.equal(elements["start-input"].dataset.artistId, startId);
    assert.equal(elements["end-input"].value, endName);
    assert.equal(elements["end-input"].dataset.artistId, endId);
    assert.equal(elements["start-suggestions"].hidden, true);
    assert.equal(elements["end-suggestions"].hidden, true);
    assert.equal(elements["start-input"].getAttribute("aria-expanded"), "false");
    assert.equal(elements["end-input"].getAttribute("aria-expanded"), "false");
    assert.equal(elements["start-game"].disabled, false);
    assert.equal(elements["swap-artists"].disabled, false);
    assert.equal(elements["share-link"].disabled, false);

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

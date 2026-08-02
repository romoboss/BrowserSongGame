import assert from "node:assert/strict";
import test from "node:test";
import { createDatabaseFixture, installFakeDocument } from "./helpers.js";

const elements = installFakeDocument([
    "start-artist",
    "target-artist",
    "artist",
    "search",
    "song-suggestions",
    "choices",
    "status",
    "move-count",
    "timer",
    "route-preview",
    "restart-challenge"
]);
elements["song-suggestions"].hidden = true;
globalThis.SONG_DATABASE = createDatabaseFixture();
document.documentElement.dataset.resultLimit = "2";
globalThis.location = {
    search: "?start=1&end=3",
    href: "",
    replacedWith: "",
    reloadCount: 0,
    replace(url) {
        this.replacedWith = url;
    },
    reload() {
        this.reloadCount += 1;
    }
};

await import("../game.js");

function chooseSong(searchText, songId) {
    elements.search.value = searchText;
    elements.search.dispatch("input");
    const suggestion = elements["song-suggestions"].children.find(
        element => element.dataset.songId === String(songId)
    );
    assert.ok(suggestion, `Expected song ${songId} in autocomplete`);
    suggestion.dispatch("click");
}

test("game records the final move, disables dead ends, and opens results", () => {
    assert.equal(elements["start-artist"].textContent, "Start Artist");
    assert.equal(elements["target-artist"].textContent, "Target Artist");
    assert.equal(elements.artist.textContent, "Start Artist");

    elements["restart-challenge"].dispatch("click");
    assert.equal(globalThis.location.reloadCount, 1);

    elements.search.value = "Start Solo";
    elements.search.dispatch("input");
    assert.equal(elements["song-suggestions"].children.length, 2);

    chooseSong("Bridge", 100);
    const deadEndButton = elements.choices.children.find(
        element => element.dataset.artistId === "4"
    );
    const middleButton = elements.choices.children.find(
        element => element.dataset.artistId === "2"
    );
    assert.equal(deadEndButton.disabled, true);
    assert.equal(deadEndButton.listeners.has("click"), false);
    assert.equal(middleButton.disabled, false);
    middleButton.dispatch("click");

    assert.equal(elements.artist.textContent, "Middle Artist");
    assert.equal(elements["move-count"].textContent, "1 move");

    chooseSong("Final", 101);
    const targetButton = elements.choices.children.find(
        element => element.dataset.artistId === "3"
    );
    assert.equal(targetButton.disabled, false);
    document.documentElement.dataset.theme = "black";
    targetButton.dispatch("click");

    assert.match(
        globalThis.location.replacedWith,
        /^\.\/results\.html\?theme=black&limit=2&transparency=48#/
    );
    const parameters = new URLSearchParams(globalThis.location.replacedWith.split("#")[1]);
    assert.equal(parameters.get("start"), "1");
    assert.equal(parameters.get("end"), "3");
    assert.equal(parameters.get("route"), "1|100:2|101:3");
});

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
globalThis.location = {
    search: "?start=1&end=4",
    replacedWith: "",
    replace(url) {
        this.replacedWith = url;
    }
};

await import("../js/game.js");

test("a one-song target is green, clickable, and completes the challenge", () => {
    elements.search.value = "Bridge";
    elements.search.dispatch("input");
    const suggestion = elements["song-suggestions"].children.find(
        element => element.dataset.songId === "100"
    );
    assert.ok(suggestion);
    suggestion.dispatch("click");

    const targetButton = elements.choices.children.find(
        element => element.dataset.artistId === "4"
    );
    assert.ok(targetButton);
    assert.equal(targetButton.disabled, false);
    assert.equal(targetButton.classList.contains("target-choice"), true);
    assert.equal(targetButton.classList.contains("dead-end"), false);
    assert.equal(targetButton.listeners.has("click"), true);

    targetButton.dispatch("click");
    const parameters = new URLSearchParams(globalThis.location.replacedWith.split("#")[1]);
    assert.equal(parameters.get("route"), "1|100:4");
    assert.equal(parameters.get("end"), "4");
});

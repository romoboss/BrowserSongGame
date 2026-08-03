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
    search: "?start=1&end=3&daily=2031-05-10&first=1",
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

    const startingRouteNode = elements["route-preview"].children[0].children[0];
    assert.equal(elements["route-preview"].children[0].className, "route-step");
    assert.equal(elements["route-preview"].children[0].classList.contains("is-start"), true);
    assert.equal(elements["route-preview"].children[0].classList.contains("is-current"), true);
    assert.equal(startingRouteNode.children[0].className, "route-step-label");
    assert.equal(startingRouteNode.children[0].textContent, "Start");
    assert.equal(startingRouteNode.children[1].className, "route-artist");
    assert.equal(startingRouteNode.children[1].textContent, "Start Artist");
    assert.equal(startingRouteNode.children[2].className, "route-song");
    assert.equal(startingRouteNode.children[2].textContent, "Starting artist");

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
    const middleRouteNode = elements["route-preview"].children[1].children[0];
    assert.equal(middleRouteNode.children[0].textContent, "Move 1");
    assert.equal(middleRouteNode.children[1].textContent, "Middle Artist");
    assert.equal(middleRouteNode.children[2].textContent, "via Bridge One");

    chooseSong("Final", 101);
    const targetButton = elements.choices.children.find(
        element => element.dataset.artistId === "3"
    );
    assert.equal(targetButton.disabled, false);
    document.documentElement.dataset.theme = "black";
    targetButton.dispatch("click");

    assert.match(globalThis.location.replacedWith, /^\.\/results\.html#/);
    assert.equal(globalThis.location.replacedWith.includes("?"), false);
    const parameters = new URLSearchParams(globalThis.location.replacedWith.split("#")[1]);
    assert.equal(parameters.get("start"), "1");
    assert.equal(parameters.get("end"), "3");
    assert.equal(parameters.get("route"), "1|100:2|101:3");
    assert.equal(parameters.get("daily"), "2031-05-10");
    assert.equal(parameters.get("first"), "1");
    assert.equal(parameters.has("archive"), false);

    const finishingRouteItem = elements["route-preview"].children[2];
    const finishingRouteNode = finishingRouteItem.children[0];
    assert.equal(finishingRouteItem.classList.contains("is-current"), true);
    assert.equal(finishingRouteNode.children[0].textContent, "Move 2");
    assert.equal(finishingRouteNode.children[1].textContent, "Target Artist");
    assert.equal(finishingRouteNode.children[2].textContent, "via Final Link");
});

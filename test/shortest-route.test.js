import assert from "node:assert/strict";
import test from "node:test";
import { createDatabaseFixture } from "./helpers.js";
import {
    findShortestRoute,
    formatRoute,
    resolveArtist
} from "../tools/print-shortest-route.js";

test("shortest-route helper follows the lucky-picker connection rules", () => {
    const database = createDatabaseFixture();
    const start = resolveArtist(database, "start artist");
    const end = resolveArtist(database, "Target Artist");
    const route = findShortestRoute(database, start.id, end.id);

    assert.deepEqual(route, {
        artistIds: ["1", "2", "3"],
        songIds: ["100", "101"]
    });
    assert.equal(
        formatRoute(database, route),
        [
            "Shortest route: Start Artist -> Target Artist",
            "2 connections",
            "",
            "1. Start Artist (artist id:1)",
            "   via \"Bridge One\" (song id:100)",
            "2. Middle Artist (artist id:2)",
            "   via \"Final Link\" (song id:101)",
            "3. Target Artist (artist id:3)"
        ].join("\n")
    );
});

test("shortest-route helper reports an unreachable artist", () => {
    const database = createDatabaseFixture();
    database.artists[5] = "Unreachable Artist";
    database.artistSongs[5] = [];

    assert.equal(findShortestRoute(database, "1", "5"), null);
    assert.equal(
        formatRoute(database, null),
        "No route was found under the current game rules."
    );
});

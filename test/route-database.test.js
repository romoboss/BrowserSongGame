import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

await import("../data/database.js");
await import("../data/route-database.js");
await import("../data/route-graph.js");

const database = globalThis.SONG_DATABASE;
const routeDatabase = globalThis.SONG_ROUTE_DATABASE;
const routeGraph = globalThis.SONG_ROUTE_GRAPH;
const rowsById = new Map(routeDatabase.records.map(row => [String(row[0]), row]));

test("the compact route-picker data remains in sync with the full database", () => {
    assert.equal(routeDatabase.graphVersion, routeGraph.version);
    assert.equal(routeDatabase.records.length, Object.keys(database.artists).length);

    for (const [artistId, name] of Object.entries(database.artists)) {
        const row = rowsById.get(artistId);
        assert.ok(row, `Missing compact record for artist ${artistId}`);
        assert.equal(row[1], name);
        assert.equal(row[2], (database.artistSongs[artistId] || []).length);

        const expectedNeighbors = new Set();
        for (const songId of database.artistSongs[artistId] || []) {
            for (const nextArtistId of database.songData[songId]?.artists || []) {
                if (String(nextArtistId) !== artistId) expectedNeighbors.add(Number(nextArtistId));
            }
        }
        assert.deepEqual(routeGraph.adjacency[Number(artistId)], [...expectedNeighbors].sort((a, b) => a - b));
    }
});

test("component metadata exactly represents the one-song traversal rule", () => {
    const calculatedSizes = [];

    for (const [artistId, row] of rowsById) {
        const componentId = row[3];
        if (componentId !== null) {
            calculatedSizes[componentId] = (calculatedSizes[componentId] || 0) + 1;
        }

        const neighboringComponents = new Set(
            (routeGraph.adjacency[Number(artistId)] || [])
                .map(id => rowsById.get(String(id)))
                .filter(neighbor => neighbor?.[2] !== 1)
                .map(neighbor => neighbor[3])
        );

        if (row[2] !== 1) {
            assert.notEqual(componentId, null);
            for (const nextId of routeGraph.adjacency[Number(artistId)] || []) {
                const nextRow = rowsById.get(String(nextId));
                if (nextRow[2] !== 1) assert.equal(nextRow[3], componentId);
            }
        } else if (neighboringComponents.size === 1) {
            assert.equal(componentId, neighboringComponents.values().next().value);
        } else {
            assert.equal(componentId, null);
            assert.deepEqual(
                routeDatabase.terminalAdjacency[Number(artistId)] || [],
                routeGraph.adjacency[Number(artistId)] || []
            );
        }
    }

    assert.deepEqual(calculatedSizes, routeDatabase.componentSizes);
});

test("the Route Picker loads the compact index before setup and not the full song database", async () => {
    const html = await readFile(new URL("../route-picker.html", import.meta.url), "utf8");
    const routeDataIndex = html.indexOf("./data/route-database.js");
    const setupIndex = html.indexOf("./js/setup.js");

    assert.ok(routeDataIndex >= 0);
    assert.ok(setupIndex > routeDataIndex);
    assert.equal(html.includes('<script src="./data/database.js'), false);
});

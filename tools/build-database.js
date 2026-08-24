import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(toolsDirectory, "..");
const outputDirectory = path.resolve(
    process.argv[2] || process.env.DATABASE_DIR || path.join(projectDirectory, "output")
);

async function readJson(fileName) {
    const filePath = path.join(outputDirectory, fileName);

    try {
        return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
        throw new Error(`Could not read ${filePath}: ${error.message}`);
    }
}

const [artistsFile, songsFile, artistSongsFile, songDataFile, manifest] =
    await Promise.all([
        readJson("artists.json"),
        readJson("songs.json"),
        readJson("artistSongs.json"),
        readJson("main.json"),
        readJson("manifest.json")
    ]);

const database = {
    manifest,
    artists: artistsFile.artists,
    songs: songsFile.songs,
    artistSongs: artistSongsFile.artistSongs,
    songData: songDataFile.data
};

if (!database.artists || !database.songs || !database.artistSongs || !database.songData) {
    throw new Error("The output directory does not contain a valid song database.");
}

function buildRouteDatabase(fullDatabase) {
    const artistIds = Object.keys(fullDatabase.artists);
    const artistIdSet = new Set(artistIds);
    const adjacencySets = new Map(artistIds.map(id => [id, new Set()]));

    for (const artistId of artistIds) {
        for (const songId of fullDatabase.artistSongs[artistId] || []) {
            const songArtists = fullDatabase.songData[songId]?.artists;
            if (!Array.isArray(songArtists)) {
                throw new Error(`Artist ${artistId} references missing song data for ${songId}.`);
            }
            if (!songArtists.some(id => String(id) === artistId)) {
                throw new Error(`Song ${songId} does not link back to artist ${artistId}.`);
            }

            for (const nextArtistIdValue of songArtists) {
                const nextArtistId = String(nextArtistIdValue);
                if (!artistIdSet.has(nextArtistId)) {
                    throw new Error(`Song ${songId} references unknown artist ${nextArtistId}.`);
                }
                if (nextArtistId !== artistId) adjacencySets.get(artistId).add(nextArtistId);
            }
        }
    }

    for (const [artistId, neighbors] of adjacencySets) {
        for (const neighborId of neighbors) {
            if (!adjacencySets.get(neighborId)?.has(artistId)) {
                throw new Error(
                    `Artist graph is asymmetric between ${artistId} and ${neighborId}; `
                    + "route-picker component metadata would not preserve traversal rules."
                );
            }
        }
    }

    const songCounts = new Map(
        artistIds.map(id => [id, (fullDatabase.artistSongs[id] || []).length])
    );
    const componentByArtist = new Map();
    let nextComponentId = 0;

    for (const artistId of artistIds) {
        if (songCounts.get(artistId) === 1 || componentByArtist.has(artistId)) continue;

        const componentId = nextComponentId;
        nextComponentId += 1;
        const queue = [artistId];
        componentByArtist.set(artistId, componentId);

        for (let cursor = 0; cursor < queue.length; cursor += 1) {
            for (const neighborId of adjacencySets.get(queue[cursor]) || []) {
                if (songCounts.get(neighborId) === 1 || componentByArtist.has(neighborId)) {
                    continue;
                }
                componentByArtist.set(neighborId, componentId);
                queue.push(neighborId);
            }
        }
    }

    for (const artistId of artistIds) {
        if (songCounts.get(artistId) !== 1) continue;
        const adjacentComponents = new Set(
            [...(adjacencySets.get(artistId) || [])]
                .map(neighborId => componentByArtist.get(neighborId))
                .filter(componentId => componentId !== undefined)
        );
        if (adjacentComponents.size > 1) {
            throw new Error(
                `One-song artist ${artistId} touches multiple traversal components; `
                + "route-picker component metadata would be ambiguous."
            );
        }
        if (adjacentComponents.size === 1) {
            componentByArtist.set(artistId, adjacentComponents.values().next().value);
        }
    }

    const componentSizes = [];
    for (const componentId of componentByArtist.values()) {
        componentSizes[componentId] = (componentSizes[componentId] || 0) + 1;
    }

    const maximumArtistId = Math.max(...artistIds.map(Number));
    const adjacency = Array.from({ length: maximumArtistId + 1 }, () => null);
    for (const artistId of artistIds) {
        adjacency[Number(artistId)] = [...adjacencySets.get(artistId)]
            .map(Number)
            .sort((left, right) => left - right);
    }

    const terminalAdjacency = Array.from({ length: maximumArtistId + 1 }, () => null);
    for (const artistId of artistIds) {
        if (!componentByArtist.has(artistId)) {
            terminalAdjacency[Number(artistId)] = adjacency[Number(artistId)];
        }
    }

    const graphVersion = fullDatabase.manifest?.generatedAt
        || String(fullDatabase.manifest?.formatVersion || 1);
    return {
        index: {
            manifest: fullDatabase.manifest,
            graphVersion,
            records: artistIds.map(id => [
                Number(id),
                fullDatabase.artists[id],
                songCounts.get(id),
                componentByArtist.get(id) ?? null
            ]),
            terminalAdjacency,
            componentSizes
        },
        graph: {
            version: graphVersion,
            adjacency
        }
    };
}

const destination = path.join(projectDirectory, "data", "database.js");
const routeDestination = path.join(projectDirectory, "data", "route-database.js");
const routeGraphDestination = path.join(projectDirectory, "data", "route-graph.js");
const routeData = buildRouteDatabase(database);
const source = [
    "// Generated from the JSON files in output. Run `npm run build:database` to refresh.",
    `globalThis.SONG_DATABASE = ${JSON.stringify(database)};`,
    ""
].join("\n");
const routeSource = [
    "// Generated from the JSON files in output. Run `npm run build:database` to refresh.",
    `globalThis.SONG_ROUTE_DATABASE = ${JSON.stringify(routeData.index)};`,
    ""
].join("\n");
const routeGraphSource = [
    "// Generated from the JSON files in output. Run `npm run build:database` to refresh.",
    `globalThis.SONG_ROUTE_GRAPH = ${JSON.stringify(routeData.graph)};`,
    ""
].join("\n");

await Promise.all([
    writeFile(destination, source, "utf8"),
    writeFile(routeDestination, routeSource, "utf8"),
    writeFile(routeGraphDestination, routeGraphSource, "utf8")
]);

console.log(
    `Wrote ${destination}, ${routeDestination}, and ${routeGraphDestination} with `
    + `${Object.keys(database.artists).length} artists and ${Object.keys(database.songs).length} songs.`
);

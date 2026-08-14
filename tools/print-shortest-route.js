import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(toolsDirectory, "..");

function normalize(value) {
    return String(value)
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase()
        .trim();
}

function requireDatabase(database) {
    if (
        !database?.artists
        || !database?.songs
        || !database?.artistSongs
        || !database?.songData
    ) {
        throw new TypeError("A valid Songaveler database is required.");
    }
}

export function resolveArtist(database, query) {
    requireDatabase(database);
    const value = String(query || "").trim();
    if (!value) throw new Error("Artist names cannot be empty.");

    if (value.toLocaleLowerCase().startsWith("id:")) {
        const id = value.slice(3).trim();
        if (!database.artists[id]) throw new Error(`No artist has ID ${id}.`);
        return { id, name: database.artists[id] };
    }

    const normalizedQuery = normalize(value);
    const matches = Object.entries(database.artists)
        .filter(([, name]) => normalize(name) === normalizedQuery)
        .map(([id, name]) => ({ id: String(id), name }));

    if (matches.length === 1) return matches[0];

    if (matches.length > 1) {
        const choices = matches
            .map(artist => `${artist.name} (id:${artist.id})`)
            .join(", ");
        throw new Error(`Artist name "${value}" is ambiguous. Use one of: ${choices}`);
    }

    const suggestions = Object.entries(database.artists)
        .filter(([, name]) => normalize(name).includes(normalizedQuery))
        .sort(([leftId, leftName], [rightId, rightName]) => (
            leftName.localeCompare(rightName) || Number(leftId) - Number(rightId)
        ))
        .slice(0, 8)
        .map(([id, name]) => `${name} (id:${id})`);
    const suggestionText = suggestions.length > 0
        ? ` Possible matches: ${suggestions.join(", ")}`
        : "";
    throw new Error(`No artist named "${value}" was found.${suggestionText}`);
}

function reconstructRoute(predecessors, startId, endId) {
    const artistIds = [endId];
    const songIds = [];
    let artistId = endId;

    while (artistId !== startId) {
        const predecessor = predecessors.get(artistId);
        if (!predecessor) return null;
        songIds.unshift(predecessor.songId);
        artistId = predecessor.artistId;
        artistIds.unshift(artistId);
    }

    return { artistIds, songIds };
}

// This is the same breadth-first traversal used by the I'm Feeling Lucky
// distance calculator. One-song artists can be endpoints but are not expanded.
export function findShortestRoute(database, startId, endId) {
    requireDatabase(database);
    const sourceId = String(startId);
    const targetId = String(endId);

    if (!database.artists[sourceId]) throw new Error(`No artist has ID ${sourceId}.`);
    if (!database.artists[targetId]) throw new Error(`No artist has ID ${targetId}.`);
    if (sourceId === targetId) return { artistIds: [sourceId], songIds: [] };

    const visited = new Set([sourceId]);
    const predecessors = new Map();
    const queue = [sourceId];
    let queueIndex = 0;

    while (queueIndex < queue.length) {
        const artistId = queue[queueIndex];
        queueIndex += 1;

        for (const rawSongId of database.artistSongs[artistId] || []) {
            const songId = String(rawSongId);
            for (const rawNextArtistId of database.songData[songId]?.artists || []) {
                const nextArtistId = String(rawNextArtistId);
                if (visited.has(nextArtistId)) continue;

                visited.add(nextArtistId);
                predecessors.set(nextArtistId, { artistId, songId });
                if (nextArtistId === targetId) {
                    return reconstructRoute(predecessors, sourceId, targetId);
                }

                if ((database.artistSongs[nextArtistId] || []).length !== 1) {
                    queue.push(nextArtistId);
                }
            }
        }
    }

    return null;
}

export function formatRoute(database, route) {
    if (!route) return "No route was found under the current game rules.";

    const startName = database.artists[route.artistIds[0]];
    const endName = database.artists[route.artistIds.at(-1)];
    const connectionCount = route.songIds.length;
    const lines = [
        `Shortest route: ${startName} -> ${endName}`,
        `${connectionCount} connection${connectionCount === 1 ? "" : "s"}`,
        ""
    ];

    route.artistIds.forEach((artistId, index) => {
        lines.push(`${index + 1}. ${database.artists[artistId]} (artist id:${artistId})`);
        if (index < route.songIds.length) {
            const songId = route.songIds[index];
            lines.push(`   via "${database.songs[songId]}" (song id:${songId})`);
        }
    });

    return lines.join("\n");
}

async function loadBundledDatabase() {
    const databasePath = path.join(projectDirectory, "data", "database.js");
    await import(pathToFileURL(databasePath).href);
    requireDatabase(globalThis.SONG_DATABASE);
    return globalThis.SONG_DATABASE;
}

function printUsage() {
    console.log(
        "Usage: npm run test:route -- \"Start Artist\" \"End Artist\"\n"
        + "       node tools/print-shortest-route.js \"Start Artist\" \"End Artist\"\n\n"
        + "Use id:123 instead of a name when duplicate artist names are ambiguous."
    );
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
        printUsage();
        return;
    }
    if (args.length !== 2) {
        printUsage();
        process.exitCode = 1;
        return;
    }

    const database = await loadBundledDatabase();
    const startArtist = resolveArtist(database, args[0]);
    const endArtist = resolveArtist(database, args[1]);
    const route = findShortestRoute(database, startArtist.id, endArtist.id);
    console.log(formatRoute(database, route));
    if (!route) process.exitCode = 2;
}

const isMainModule = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
    main().catch(error => {
        console.error(`Could not calculate the route: ${error.message}`);
        process.exitCode = 1;
    });
}

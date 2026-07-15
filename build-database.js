import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
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

const destination = path.join(projectDirectory, "database.js");
const source = [
    "// Generated from the JSON files in output. Run `npm run build:database` to refresh.",
    `globalThis.SONG_DATABASE = ${JSON.stringify(database)};`,
    ""
].join("\n");

await writeFile(destination, source, "utf8");

console.log(
    `Wrote ${destination} with ${Object.keys(database.artists).length} artists and ${Object.keys(database.songs).length} songs.`
);

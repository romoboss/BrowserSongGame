import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(toolsDirectory, "..");
const DATE_KEY_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const EXPECTED_FORMAT_VERSION = 1;
const REQUIRED_CONNECTIONS = 2;
const REQUIRED_LINKED_SONGS = 25;

export function isValidDateKey(dateKey) {
    if (typeof dateKey !== "string" || !DATE_KEY_PATTERN.test(dateKey)) return false;

    const date = new Date(`${dateKey}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === dateKey;
}

export function shiftUtcDateKey(dateKey, days) {
    if (!isValidDateKey(dateKey) || !Number.isInteger(days)) {
        throw new RangeError("A real date key and an integer day offset are required.");
    }

    const date = new Date(`${dateKey}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function requireObject(value, description) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${description} must be an object.`);
    }
}

export function validateDatabase(database) {
    requireObject(database, "The song database");
    requireObject(database.manifest, "The song database manifest");
    requireObject(database.artists, "The song database artists table");
    requireObject(database.artistSongs, "The song database artist-song table");
    requireObject(database.songData, "The song database song data table");

    if (
        typeof database.manifest.generatedAt !== "string"
        || database.manifest.generatedAt.length === 0
    ) {
        throw new TypeError("The song database manifest must include generatedAt.");
    }

    return database;
}

function validateEntry(entry, dateKey, database) {
    requireObject(entry, `The Daily Challenge entry for ${dateKey}`);

    if (
        typeof entry.startId !== "string"
        || entry.startId.length === 0
        || typeof entry.endId !== "string"
        || entry.endId.length === 0
        || entry.startId === entry.endId
        || typeof entry.startName !== "string"
        || entry.startName.length === 0
        || typeof entry.endName !== "string"
        || entry.endName.length === 0
        || entry.requiredConnections !== REQUIRED_CONNECTIONS
        || entry.requiredLinkedSongs !== REQUIRED_LINKED_SONGS
        || typeof entry.sourceDatabaseGeneratedAt !== "string"
        || entry.sourceDatabaseGeneratedAt.length === 0
    ) {
        throw new TypeError(`The Daily Challenge entry for ${dateKey} is invalid.`);
    }

    if (database) {
        if (typeof database.artists[entry.startId] !== "string") {
            throw new Error(
                `Saved Daily Challenge ${dateKey} references missing start artist ${entry.startId}.`
            );
        }
        if (typeof database.artists[entry.endId] !== "string") {
            throw new Error(
                `Saved Daily Challenge ${dateKey} references missing end artist ${entry.endId}.`
            );
        }
    }
}

export function validateChallengeTable(table, database = null) {
    requireObject(table, "The Daily Challenge table");
    if (table.formatVersion !== EXPECTED_FORMAT_VERSION) {
        throw new TypeError(
            `The Daily Challenge table must use format version ${EXPECTED_FORMAT_VERSION}.`
        );
    }
    if (!isValidDateKey(table.firstDate)) {
        throw new TypeError("The Daily Challenge table has an invalid firstDate.");
    }
    requireObject(table.entries, "The Daily Challenge entries table");
    if (database) validateDatabase(database);

    const dates = Object.keys(table.entries).sort();
    if (dates.length === 0 || dates[0] !== table.firstDate) {
        throw new TypeError(
            "The Daily Challenge table must contain an entry for its firstDate."
        );
    }

    let expectedDate = table.firstDate;
    for (const dateKey of dates) {
        if (!isValidDateKey(dateKey) || dateKey !== expectedDate) {
            throw new TypeError(
                `The Daily Challenge table is not contiguous at ${expectedDate}.`
            );
        }
        validateEntry(table.entries[dateKey], dateKey, database);
        expectedDate = shiftUtcDateKey(expectedDate, 1);
    }

    return Object.freeze({
        dates,
        firstDate: table.firstDate,
        lastDate: dates.at(-1)
    });
}

export async function loadAssignedGlobal(filePath, globalName) {
    const source = await readFile(filePath, "utf8");
    const context = vm.createContext(Object.create(null), {
        codeGeneration: { strings: false, wasm: false }
    });

    try {
        new vm.Script(source, { filename: filePath }).runInContext(context, { timeout: 5_000 });
    } catch (error) {
        throw new Error(`Could not evaluate ${filePath}: ${error.message}`, { cause: error });
    }

    const value = context[globalName];
    if (value == null) {
        throw new Error(`${filePath} did not assign globalThis.${globalName}.`);
    }
    return value;
}

export function appendDailyChallenges({ table, database, today, generator }) {
    validateDatabase(database);
    // Old rows are immutable snapshots. A later database may stop exporting one of
    // their artists, but that must not prevent newer rows from being archived.
    const tableDetails = validateChallengeTable(table);
    if (!isValidDateKey(today)) {
        throw new RangeError("--today must be a real date in YYYY-MM-DD format.");
    }
    if (!generator || typeof generator.generate !== "function") {
        throw new TypeError("A Daily Challenge generator is required.");
    }

    if (tableDetails.lastDate > today) {
        throw new Error(
            `The saved table ends at ${tableDetails.lastDate}, after today (${today}).`
        );
    }
    if (tableDetails.lastDate === today) {
        return Object.freeze({
            changed: false,
            addedDates: [],
            table,
            throughDate: today
        });
    }

    const entries = { ...table.entries };
    const addedDates = [];
    for (
        let dateKey = shiftUtcDateKey(tableDetails.lastDate, 1);
        dateKey <= today;
        dateKey = shiftUtcDateKey(dateKey, 1)
    ) {
        if (Object.hasOwn(entries, dateKey)) {
            throw new Error(`Refusing to overwrite the saved Daily Challenge for ${dateKey}.`);
        }

        const challenge = generator.generate(database, dateKey);
        if (!challenge) {
            throw new Error(`No eligible Daily Challenge could be generated for ${dateKey}.`);
        }

        const startId = String(challenge.startId);
        const endId = String(challenge.endId);
        const startName = database.artists[startId];
        const endName = database.artists[endId];
        if (typeof startName !== "string" || typeof endName !== "string") {
            throw new Error(
                `Generated Daily Challenge ${dateKey} references an unknown artist.`
            );
        }

        entries[dateKey] = {
            startId,
            endId,
            startName,
            endName,
            requiredConnections: challenge.requiredConnections,
            requiredLinkedSongs: challenge.requiredLinkedSongs,
            sourceDatabaseGeneratedAt: database.manifest.generatedAt
        };
        addedDates.push(dateKey);
    }

    const updatedTable = {
        formatVersion: EXPECTED_FORMAT_VERSION,
        firstDate: table.firstDate,
        entries
    };
    validateChallengeTable(updatedTable);

    return Object.freeze({
        changed: addedDates.length > 0,
        addedDates,
        table: updatedTable,
        throughDate: today
    });
}

export function serializeChallengeTable(table) {
    const { dates } = validateChallengeTable(table);
    const lines = [
        "// Generated append-only data. Existing daily challenges must never be changed or removed.",
        "globalThis.SongavelerDailyChallenges = Object.freeze({",
        `    formatVersion: ${EXPECTED_FORMAT_VERSION},`,
        `    firstDate: ${JSON.stringify(table.firstDate)},`,
        "    entries: Object.freeze({"
    ];

    dates.forEach((dateKey, index) => {
        const entry = table.entries[dateKey];
        lines.push(
            `        ${JSON.stringify(dateKey)}: Object.freeze({`,
            `            startId: ${JSON.stringify(entry.startId)},`,
            `            endId: ${JSON.stringify(entry.endId)},`,
            `            startName: ${JSON.stringify(entry.startName)},`,
            `            endName: ${JSON.stringify(entry.endName)},`,
            `            requiredConnections: ${entry.requiredConnections},`,
            `            requiredLinkedSongs: ${entry.requiredLinkedSongs},`,
            `            sourceDatabaseGeneratedAt: ${JSON.stringify(entry.sourceDatabaseGeneratedAt)}`,
            `        })${index === dates.length - 1 ? "" : ","}`
        );
    });

    lines.push("    })", "});", "");
    return lines.join("\n");
}

export function parseArguments(argv) {
    const options = {
        databasePath: path.join(projectDirectory, "data", "database.js"),
        challengesPath: path.join(projectDirectory, "data", "daily-challenges.js"),
        today: new Date().toISOString().slice(0, 10)
    };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--help" || argument === "-h") {
            options.help = true;
            continue;
        }

        const value = argv[index + 1];
        if (["--database", "--challenges", "--today"].includes(argument)) {
            if (value == null) throw new Error(`${argument} requires a value.`);
            index += 1;
        }

        if (argument === "--database") options.databasePath = path.resolve(value);
        else if (argument === "--challenges") options.challengesPath = path.resolve(value);
        else if (argument === "--today") options.today = value;
        else if (argument !== "--help" && argument !== "-h") {
            throw new Error(`Unknown option: ${argument}`);
        }
    }

    if (!isValidDateKey(options.today)) {
        throw new RangeError("--today must be a real date in YYYY-MM-DD format.");
    }
    return options;
}

function printUsage() {
    console.log(
        "Usage: node tools/update-daily-challenges.js "
        + "[--database <path>] [--challenges <path>] [--today YYYY-MM-DD]"
    );
}

async function writeAtomically(filePath, source) {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    try {
        await writeFile(temporaryPath, source, "utf8");
        await rename(temporaryPath, filePath);
    } catch (error) {
        await unlink(temporaryPath).catch(() => {});
        throw error;
    }
}

export async function run(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    if (options.help) {
        printUsage();
        return { changed: false, help: true };
    }

    const [database, table] = await Promise.all([
        loadAssignedGlobal(options.databasePath, "SONG_DATABASE"),
        loadAssignedGlobal(options.challengesPath, "SongavelerDailyChallenges")
    ]);
    await import("../js/daily-generator.js");
    const generator = globalThis.SongavelerDailyGenerator;
    const result = appendDailyChallenges({
        table,
        database,
        today: options.today,
        generator
    });

    if (!result.changed) {
        console.log(`Daily Challenge archive is already saved through ${result.throughDate}.`);
        return result;
    }

    await writeAtomically(options.challengesPath, serializeChallengeTable(result.table));
    console.log(
        `Saved ${result.addedDates.length} Daily Challenge(s), `
        + `${result.addedDates[0]} through ${result.addedDates.at(-1)}.`
    );
    return result;
}

const isDirectRun = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
    run().catch(error => {
        console.error(`Error: ${error.message}`);
        process.exitCode = 1;
    });
}

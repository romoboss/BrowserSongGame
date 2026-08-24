import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    appendDailyChallenges,
    serializeChallengeTable
} from "../tools/update-daily-challenges.js";

function createDatabase(generatedAt = "2032-02-27T18:30:00Z") {
    return {
        manifest: { generatedAt },
        artists: {
            1: "Original Start",
            2: "Original Target",
            3: "Previous Database Alpha",
            4: "Previous Database Bravo",
            5: "Previous Database Charlie"
        },
        artistSongs: {},
        songData: {}
    };
}

function createTable() {
    return {
        formatVersion: 1,
        firstDate: "2032-02-27",
        entries: {
            "2032-02-27": {
                startId: "1",
                endId: "2",
                startName: "Original Start",
                endName: "Original Target",
                requiredConnections: 2,
                requiredLinkedSongs: 25,
                sourceDatabaseGeneratedAt: "2032-02-20T12:00:00Z"
            }
        }
    };
}

test("updater saves every missing UTC date through today from the supplied database", () => {
    const table = createTable();
    const originalTable = structuredClone(table);
    const previousDatabase = createDatabase();
    const generatedPairs = {
        "2032-02-28": ["3", "4"],
        "2032-02-29": ["4", "5"],
        "2032-03-01": ["5", "3"],
        "2032-03-02": ["3", "5"]
    };
    const generateCalls = [];
    const generator = {
        generate(database, dateKey) {
            generateCalls.push({ database, dateKey });
            const [startId, endId] = generatedPairs[dateKey];
            return {
                dateKey,
                startId,
                endId,
                requiredConnections: 2,
                requiredLinkedSongs: 25
            };
        }
    };

    const result = appendDailyChallenges({
        table,
        database: previousDatabase,
        today: "2032-03-02",
        generator
    });

    assert.equal(result.changed, true);
    assert.equal(result.throughDate, "2032-03-02");
    assert.deepEqual(
        result.addedDates,
        ["2032-02-28", "2032-02-29", "2032-03-01", "2032-03-02"]
    );
    assert.deepEqual(generateCalls.map(call => call.dateKey), result.addedDates);
    assert.ok(generateCalls.every(call => call.database === previousDatabase));
    assert.deepEqual(table, originalTable, "Appending must not mutate or overwrite saved history");
    assert.notEqual(result.table, table);
    assert.deepEqual(result.table.entries["2032-02-27"], table.entries["2032-02-27"]);
    assert.deepEqual(result.table.entries["2032-02-29"], {
        startId: "4",
        endId: "5",
        startName: "Previous Database Bravo",
        endName: "Previous Database Charlie",
        requiredConnections: 2,
        requiredLinkedSongs: 25,
        sourceDatabaseGeneratedAt: "2032-02-27T18:30:00Z"
    });
});

test("updater is a no-op when the current challenge is already saved", () => {
    const initial = appendDailyChallenges({
        table: createTable(),
        database: createDatabase(),
        today: "2032-03-02",
        generator: {
            generate(_database, dateKey) {
                const ids = dateKey === "2032-02-28"
                    ? ["3", "4"]
                    : dateKey === "2032-02-29"
                        ? ["4", "5"]
                        : ["5", "3"];
                return {
                    startId: ids[0],
                    endId: ids[1],
                    requiredConnections: 2,
                    requiredLinkedSongs: 25
                };
            }
        }
    });
    const result = appendDailyChallenges({
        table: initial.table,
        database: createDatabase(),
        today: "2032-03-02",
        generator: {
            generate() {
                assert.fail("A caught-up archive must not invoke the generator");
            }
        }
    });

    assert.equal(result.changed, false);
    assert.deepEqual(result.addedDates, []);
    assert.equal(result.table, initial.table);
    assert.equal(result.throughDate, "2032-03-02");
});

test("updater fails atomically when a missing date has no eligible challenge", () => {
    const table = createTable();
    const originalTable = structuredClone(table);

    assert.throws(
        () => appendDailyChallenges({
            table,
            database: createDatabase(),
            today: "2032-03-02",
            generator: { generate: () => null }
        }),
        /No eligible Daily Challenge could be generated for 2032-02-28/
    );
    assert.deepEqual(table, originalTable);
});

test("updater rejects holes in saved history", () => {
    const table = createTable();
    table.entries["2032-03-01"] = {
        ...table.entries["2032-02-27"],
        startId: "2",
        endId: "1"
    };

    assert.throws(
        () => appendDailyChallenges({
            table,
            database: createDatabase(),
            today: "2032-03-03",
            generator: { generate: () => assert.fail("Invalid history must not generate") }
        }),
        /not contiguous at 2032-02-28/
    );
});

test("updater rejects a table that already extends beyond today", () => {
    const table = createTable();
    table.entries["2032-02-28"] = {
        ...table.entries["2032-02-27"],
        startId: "2",
        endId: "1"
    };
    table.entries["2032-02-29"] = {
        ...table.entries["2032-02-27"]
    };
    table.entries["2032-03-01"] = {
        ...table.entries["2032-02-27"],
        startId: "2",
        endId: "1"
    };

    assert.throws(
        () => appendDailyChallenges({
            table,
            database: createDatabase(),
            today: "2032-02-28",
            generator: { generate: () => assert.fail("A future-ending table must not generate") }
        }),
        /ends at 2032-03-01, after today \(2032-02-28\)/
    );
});

test("updater rejects malformed dates before generating", () => {
    assert.throws(
        () => appendDailyChallenges({
            table: createTable(),
            database: createDatabase(),
            today: "2032-02-30",
            generator: { generate: () => assert.fail("A malformed date must not generate") }
        }),
        { name: "RangeError" }
    );
});

test("serialized challenge data preserves the public global and append-only metadata", () => {
    const source = serializeChallengeTable(createTable());

    assert.match(source, /globalThis\.SongavelerDailyChallenges = Object\.freeze/);
    assert.match(source, /firstDate: "2032-02-27"/);
    assert.match(source, /sourceDatabaseGeneratedAt: "2032-02-20T12:00:00Z"/);
    assert.ok(source.endsWith("\n"));
});

test("GitHub automation archives the pre-push database and deploys the bot update", async () => {
    const workflow = await readFile(
        new URL("../.github/workflows/update-daily-challenges.yml", import.meta.url),
        "utf8"
    );

    assert.match(workflow, /PREVIOUS_SHA: \$\{\{ github\.event\.before \}\}/);
    assert.match(workflow, /schedule:\s*\n\s*- cron: "10 0 \* \* \*"/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /PREVIOUS_SHA=\$\(git rev-parse HEAD\)/);
    assert.match(workflow, /previous_database_path=data\/database\.js/);
    assert.match(workflow, /previous_database_path=database\.js/);
    assert.match(workflow, /git show "\$\{PREVIOUS_SHA\}:\$\{previous_database_path\}"/);
    assert.match(workflow, /node tools\/update-daily-challenges\.js/);
    assert.match(workflow, /git add -- data\/daily-challenges\.js/);
    assert.match(workflow, /uses: actions\/upload-pages-artifact@v4/);
    assert.match(workflow, /uses: actions\/deploy-pages@v4/);
});

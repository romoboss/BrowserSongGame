import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { installFakeDocument } from "./helpers.js";

const ARCHIVE_ELEMENT_IDS = [
    "archive-form",
    "archive-date-input",
    "archive-date-output",
    "archive-start-artist",
    "archive-end-artist",
    "archive-status",
    "archive-play-link",
    "archive-content",
    "archive-error"
];
const RealDate = globalThis.Date;
let archiveImportNumber = 0;

const SAVED_CHALLENGES = {
    formatVersion: 1,
    firstDate: "2031-05-07",
    entries: {
        "2031-05-07": {
            startId: "1",
            endId: "3",
            startName: "Historic Alpha",
            endName: "Historic Bravo",
            requiredConnections: 2,
            requiredLinkedSongs: 25,
            sourceDatabaseGeneratedAt: "2031-05-06T18:30:00Z"
        },
        "2031-05-08": {
            startId: "3",
            endId: "1",
            startName: "Historic Bravo",
            endName: "Historic Alpha",
            requiredConnections: 2,
            requiredLinkedSongs: 25,
            sourceDatabaseGeneratedAt: "2031-05-06T18:30:00Z"
        }
    }
};

globalThis.SongavelerDailyChallenges = SAVED_CHALLENGES;

function createDailyDatabase(reverseArtists = false) {
    const artistEntries = [
        [1, "Alpha"],
        [2, "Alpha Bridge"],
        [3, "Bravo"],
        [4, "Charlie"],
        [5, "Charlie Bridge"],
        [6, "Delta"]
    ];
    const artists = Object.fromEntries(reverseArtists ? artistEntries.reverse() : artistEntries);
    const songs = {
        100: "Alpha First",
        101: "Alpha Second",
        200: "Charlie First",
        201: "Charlie Second"
    };
    const artistSongs = {
        1: [100],
        2: [100, 101],
        3: [101],
        4: [200],
        5: [200, 201],
        6: [201]
    };
    const songData = {
        100: { artists: [1, 2] },
        101: { artists: [2, 3] },
        200: { artists: [4, 5] },
        201: { artists: [5, 6] }
    };

    for (const artistId of [1, 3, 4, 6]) {
        for (let index = 1; index <= 24; index += 1) {
            const songId = artistId * 1000 + index;
            songs[songId] = `${artists[artistId]} Solo ${index}`;
            artistSongs[artistId].push(songId);
            songData[songId] = { artists: [artistId] };
        }
    }

    return { artists, songs, artistSongs, songData };
}

await import("../js/daily-generator.js");

function installDate(instant) {
    globalThis.Date = class extends RealDate {
        constructor(...args) {
            super(...(args.length > 0 ? args : [instant]));
        }

        static now() {
            return new RealDate(instant).getTime();
        }
    };
}

async function dispatchArchiveForm(elements, dateKey, instant) {
    installDate(instant);
    try {
        elements["archive-date-input"].value = dateKey;
        await elements["archive-form"].dispatch("submit", { preventDefault() {} });
    } finally {
        globalThis.Date = RealDate;
    }
}

test("daily generator is deterministic across database insertion order", () => {
    const first = globalThis.SongavelerDailyGenerator.generate(
        createDailyDatabase(),
        "2035-11-12"
    );
    const second = globalThis.SongavelerDailyGenerator.generate(
        createDailyDatabase(true),
        "2035-11-12"
    );

    assert.deepEqual(second, first);
    assert.equal(first.dateKey, "2035-11-12");
    assert.equal(first.requiredConnections, 2);
    assert.equal(first.requiredLinkedSongs, 25);
});

test("daily generator accepts only real YYYY-MM-DD dates", () => {
    const generator = globalThis.SongavelerDailyGenerator;

    assert.equal(generator.isValidDateKey("2028-02-29"), true);
    assert.equal(generator.isValidDateKey("2027-02-29"), false);
    assert.equal(generator.isValidDateKey("03/08/2026"), false);
    assert.throws(
        () => generator.generate(createDailyDatabase(), "2026-02-30"),
        { name: "RangeError" }
    );
});

test("fixed daily rules ignore saved Lucky settings", () => {
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = {
        getItem(key) {
            if (key.includes("setting")) return "999";
            return null;
        }
    };

    try {
        const challenge = globalThis.SongavelerDailyGenerator.generate(
            createDailyDatabase(),
            "2031-05-10"
        );
        const eligibleOrderedPairs = new Set(["1:3", "3:1", "4:6", "6:4"]);

        assert.ok(challenge);
        assert.ok(eligibleOrderedPairs.has(`${challenge.startId}:${challenge.endId}`));
    } finally {
        globalThis.localStorage = previousStorage;
    }
});

test("saved daily challenges take precedence over regeneration", () => {
    const generator = globalThis.SongavelerDailyGenerator;
    const database = createDailyDatabase();
    const saved = generator.getSaved("2031-05-07");
    const resolved = generator.resolve(database, "2031-05-07");
    const generated = generator.generate(database, "2031-05-07");

    assert.equal(saved.dateKey, "2031-05-07");
    assert.equal(saved.startName, "Historic Alpha");
    assert.equal(saved.endName, "Historic Bravo");
    assert.equal(saved.sourceDatabaseGeneratedAt, "2031-05-06T18:30:00Z");
    assert.equal(resolved.startId, "1");
    assert.equal(resolved.endId, "3");
    assert.notDeepEqual(
        [generated.startId, generated.endId],
        [resolved.startId, resolved.endId],
        "The fixture must prove that resolving a saved date does not regenerate it"
    );
});

test("archive resolution uses saved entries, fills the unsaved gap, and enforces UTC bounds", () => {
    const generator = globalThis.SongavelerDailyGenerator;
    const database = createDailyDatabase();
    const today = new RealDate("2031-05-10T12:00:00Z");

    assert.deepEqual(generator.getBounds(today), {
        firstDate: "2031-05-07",
        lastSavedDate: "2031-05-08",
        maxArchiveDate: "2031-05-09"
    });

    const saved = generator.resolveArchive(database, "2031-05-07", today);
    const gap = generator.resolveArchive(database, "2031-05-09", today);

    assert.equal(saved.startName, "Historic Alpha");
    assert.equal(saved.endName, "Historic Bravo");
    assert.deepEqual(
        [gap.startId, gap.endId],
        [
            generator.generate(database, "2031-05-09").startId,
            generator.generate(database, "2031-05-09").endId
        ]
    );
    assert.equal(generator.resolveArchive(database, "2031-05-06", today), null);
    assert.equal(generator.resolveArchive(database, "2031-05-10", today), null);
    assert.equal(generator.resolveArchive(database, "2031-05-11", today), null);
});

test("a saved current challenge stays fixed but unlocks in the archive tomorrow", () => {
    const generator = globalThis.SongavelerDailyGenerator;
    const database = createDailyDatabase();
    const currentTable = {
        ...SAVED_CHALLENGES,
        entries: {
            ...SAVED_CHALLENGES.entries,
            "2031-05-09": {
                startId: "4",
                endId: "6",
                startName: "Saved Yesterday Start",
                endName: "Saved Yesterday End",
                requiredConnections: 2,
                requiredLinkedSongs: 25,
                sourceDatabaseGeneratedAt: "2031-05-08T18:30:00Z"
            },
            "2031-05-10": {
                startId: "1",
                endId: "3",
                startName: "Saved Today Start",
                endName: "Saved Today End",
                requiredConnections: 2,
                requiredLinkedSongs: 25,
                sourceDatabaseGeneratedAt: "2031-05-09T18:30:00Z"
            }
        }
    };

    globalThis.SongavelerDailyChallenges = currentTable;
    try {
        const today = new RealDate("2031-05-10T12:00:00Z");
        const tomorrow = new RealDate("2031-05-11T12:00:00Z");
        const current = generator.resolve(database, "2031-05-10");

        assert.equal(current.source, "saved");
        assert.equal(current.startName, "Saved Today Start");
        assert.deepEqual(generator.getBounds(today), {
            firstDate: "2031-05-07",
            lastSavedDate: "2031-05-10",
            maxArchiveDate: "2031-05-09"
        });
        assert.equal(generator.resolveArchive(database, "2031-05-10", today), null);
        assert.equal(
            generator.resolveArchive(database, "2031-05-10", tomorrow).source,
            "saved"
        );
    } finally {
        globalThis.SongavelerDailyChallenges = SAVED_CHALLENGES;
    }
});

test("archive defaults to UTC yesterday, exposes its bounds, and marks replay links", async () => {
    const elements = installFakeDocument(ARCHIVE_ELEMENT_IDS);
    elements["archive-content"].hidden = true;
    elements["archive-error"].hidden = true;
    globalThis.SONG_DATABASE = createDailyDatabase();
    installDate("2031-05-09T23:59:59-07:00");

    try {
        archiveImportNumber += 1;
        await import(`../js/archive.js?archive-test=${archiveImportNumber}`);
    } finally {
        globalThis.Date = RealDate;
    }

    const link = new URL(elements["archive-play-link"].href, "https://example.test/archive.html");
    assert.equal(elements["archive-date-input"].getAttribute("min"), "2031-05-07");
    assert.equal(elements["archive-date-input"].getAttribute("max"), "2031-05-09");
    assert.equal(elements["archive-date-input"].value, "2031-05-09");
    assert.equal(elements["archive-date-output"].textContent, "2031-05-09");
    assert.equal(link.searchParams.get("daily"), "2031-05-09");
    assert.equal(link.searchParams.get("archive"), "1");
    assert.equal(link.searchParams.get("start"), "6");
    assert.equal(link.searchParams.get("end"), "4");
    assert.equal(elements["archive-content"].hidden, false);
    assert.equal(elements["archive-error"].hidden, true);
});

test("archive renders persisted names and rejects dates outside the available range", async () => {
    const instant = "2031-05-10T12:00:00Z";
    const elements = installFakeDocument(ARCHIVE_ELEMENT_IDS);
    elements["archive-content"].hidden = true;
    elements["archive-error"].hidden = true;
    globalThis.SONG_DATABASE = createDailyDatabase();
    installDate(instant);

    try {
        archiveImportNumber += 1;
        await import(`../js/archive.js?archive-test=${archiveImportNumber}`);
    } finally {
        globalThis.Date = RealDate;
    }

    await dispatchArchiveForm(elements, "2031-05-07", instant);
    let link = new URL(elements["archive-play-link"].href, "https://example.test/archive.html");
    assert.equal(elements["archive-start-artist"].textContent, "Historic Alpha");
    assert.equal(elements["archive-end-artist"].textContent, "Historic Bravo");
    assert.equal(link.searchParams.get("start"), "1");
    assert.equal(link.searchParams.get("end"), "3");

    for (const unavailableDate of ["2031-05-06", "2031-05-10", "2031-05-11"]) {
        await dispatchArchiveForm(elements, unavailableDate, instant);
        assert.equal(elements["archive-content"].hidden, true, unavailableDate);
        assert.equal(elements["archive-error"].hidden, false, unavailableDate);
        assert.ok(elements["archive-error"].textContent.length > 0, unavailableDate);
    }
});

test("archive rejects an invalid date without creating a play link", async () => {
    const elements = installFakeDocument(ARCHIVE_ELEMENT_IDS);
    elements["archive-content"].hidden = true;
    elements["archive-error"].hidden = true;
    globalThis.SONG_DATABASE = createDailyDatabase();

    installDate("2031-05-10T12:00:00Z");
    try {
        archiveImportNumber += 1;
        await import(`../js/archive.js?archive-test=${archiveImportNumber}`);
    } finally {
        globalThis.Date = RealDate;
    }
    await dispatchArchiveForm(elements, "2026-02-30", "2031-05-10T12:00:00Z");

    assert.equal(elements["archive-content"].hidden, true);
    assert.equal(elements["archive-error"].hidden, false);
    assert.equal(elements["archive-error"].textContent, "Enter a real date in YYYY-MM-DD format.");
});

test("daily, archive, and results pages load saved challenges before the resolver", async () => {
    for (const page of ["daily.html", "archive.html", "results.html"]) {
        const html = await readFile(new URL(`../${page}`, import.meta.url), "utf8");
        const savedChallengesIndex = html.indexOf("./data/daily-challenges.js");
        const generatorIndex = html.indexOf("./js/daily-generator.js");

        assert.ok(savedChallengesIndex >= 0, `${page} must load the saved challenge table`);
        assert.ok(generatorIndex > savedChallengesIndex, `${page} must load the table first`);
    }
});

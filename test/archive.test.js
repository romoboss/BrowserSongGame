import assert from "node:assert/strict";
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

await import("../daily-generator.js");

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

test("archive defaults to the current UTC date and marks replay links", async () => {
    const elements = installFakeDocument(ARCHIVE_ELEMENT_IDS);
    elements["archive-content"].hidden = true;
    elements["archive-error"].hidden = true;
    globalThis.SONG_DATABASE = createDailyDatabase();
    globalThis.Date = class extends RealDate {
        constructor(...args) {
            super(...(args.length > 0 ? args : ["2031-05-09T23:59:59-07:00"]));
        }

        static now() {
            return new RealDate("2031-05-09T23:59:59-07:00").getTime();
        }
    };

    try {
        archiveImportNumber += 1;
        await import(`../archive.js?archive-test=${archiveImportNumber}`);
    } finally {
        globalThis.Date = RealDate;
    }

    const link = new URL(elements["archive-play-link"].href, "https://example.test/archive.html");
    assert.equal(elements["archive-date-input"].value, "2031-05-10");
    assert.equal(elements["archive-date-output"].textContent, "2031-05-10");
    assert.equal(link.searchParams.get("daily"), "2031-05-10");
    assert.equal(link.searchParams.get("archive"), "1");
    assert.ok(link.searchParams.get("start"));
    assert.ok(link.searchParams.get("end"));
    assert.equal(elements["archive-content"].hidden, false);
    assert.equal(elements["archive-error"].hidden, true);
});

test("archive rejects an invalid date without creating a play link", async () => {
    const elements = installFakeDocument(ARCHIVE_ELEMENT_IDS);
    elements["archive-content"].hidden = true;
    elements["archive-error"].hidden = true;
    globalThis.SONG_DATABASE = createDailyDatabase();

    archiveImportNumber += 1;
    await import(`../archive.js?archive-test=${archiveImportNumber}`);
    elements["archive-date-input"].value = "2026-02-30";
    await elements["archive-form"].dispatch("submit", { preventDefault() {} });

    assert.equal(elements["archive-content"].hidden, true);
    assert.equal(elements["archive-error"].hidden, false);
    assert.equal(elements["archive-error"].textContent, "Enter a real date in YYYY-MM-DD format.");
});

import assert from "node:assert/strict";
import test from "node:test";
import { installFakeDocument } from "./helpers.js";

const DAILY_ELEMENT_IDS = [
    "daily-date",
    "daily-start-artist",
    "daily-end-artist",
    "daily-status",
    "daily-play-link",
    "daily-content",
    "daily-error",
    "daily-error-message",
    "daily-completion",
    "daily-completion-moves",
    "daily-completion-time",
    "daily-stat-completed",
    "daily-stat-streak",
    "daily-stat-average-moves",
    "daily-stat-average-time"
];
const RealDate = globalThis.Date;
let importNumber = 0;

await import("../daily-generator.js");

function createDailyDatabase() {
    const artists = {
        1: "Alpha",
        2: "Alpha Bridge",
        3: "Bravo",
        4: "Charlie",
        5: "Charlie Bridge",
        6: "Delta"
    };
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

async function renderDaily(
    instant,
    database = createDailyDatabase(),
    settings = {},
    savedProgress = {}
) {
    const elements = installFakeDocument(DAILY_ELEMENT_IDS);
    elements["daily-content"].hidden = true;
    elements["daily-error"].hidden = true;
    elements["daily-completion"].hidden = true;
    Object.assign(document.documentElement.dataset, settings);
    globalThis.SONG_DATABASE = database;
    globalThis.SongavelerDailyProgress = {
        claimFirstAttempt: () => savedProgress.firstAttempt ?? true,
        getCompletion: () => savedProgress.completion || null,
        getStats: () => savedProgress.stats || {
            completedCount: 0,
            currentStreak: 0,
            averageMoves: null,
            averageElapsedMs: null
        }
    };

    globalThis.Date = class extends RealDate {
        constructor(...args) {
            super(...(args.length > 0 ? args : [instant]));
        }

        static now() {
            return new RealDate(instant).getTime();
        }
    };

    try {
        importNumber += 1;
        await import(`../daily.js?daily-test=${importNumber}`);
    } finally {
        globalThis.Date = RealDate;
    }

    return elements;
}

function getRenderedChallenge(elements) {
    const link = new URL(elements["daily-play-link"].href, "https://example.test/daily.html");
    return {
        start: link.searchParams.get("start"),
        end: link.searchParams.get("end"),
        daily: link.searchParams.get("daily")
    };
}

test("daily challenge uses the UTC date and fixed Lucky defaults", async () => {
    const elements = await renderDaily(
        "2031-05-09T23:59:59-07:00",
        createDailyDatabase(),
        { luckyConnections: "1", luckyLinkedSongs: "999" }
    );
    const challenge = getRenderedChallenge(elements);
    const eligibleOrderedPairs = new Set(["1:3", "3:1", "4:6", "6:4"]);

    assert.equal(elements["daily-date"].textContent, "2031-05-10");
    assert.equal(elements["daily-date"].getAttribute("datetime"), "2031-05-10");
    assert.equal(challenge.daily, "2031-05-10");
    assert.equal(elements["daily-play-link"].href,
        `./game?start=${challenge.start}&end=${challenge.end}&daily=2031-05-10`);
    await elements["daily-play-link"].dispatch("click");
    assert.equal(
        new URL(elements["daily-play-link"].href, "https://example.test").searchParams.get("first"),
        "1"
    );
    assert.ok(eligibleOrderedPairs.has(`${challenge.start}:${challenge.end}`));
    assert.equal(
        elements["daily-start-artist"].textContent,
        globalThis.SONG_DATABASE.artists[challenge.start]
    );
    assert.equal(
        elements["daily-end-artist"].textContent,
        globalThis.SONG_DATABASE.artists[challenge.end]
    );
    assert.equal(elements["daily-content"].hidden, false);
    assert.equal(elements["daily-error"].hidden, true);
    assert.equal(elements["daily-completion"].hidden, true);
    assert.equal(elements["daily-stat-completed"].textContent, "0");
    assert.equal(elements["daily-stat-average-time"].textContent, "—");
    assert.equal(
        elements["daily-status"].textContent,
        "Today’s artists are 2 connections apart and each have at least 25 linked songs."
    );
});

test("daily page shows today's first completion and aggregate stats", async () => {
    const elements = await renderDaily(
        "2031-05-10T12:00:00Z",
        createDailyDatabase(),
        {},
        {
            completion: { moves: 4, elapsedMs: 83_000 },
            firstAttempt: false,
            stats: {
                completedCount: 7,
                currentStreak: 3,
                averageMoves: 4.25,
                averageElapsedMs: 90_500
            }
        }
    );

    assert.equal(elements["daily-completion"].hidden, false);
    assert.equal(elements["daily-completion-moves"].textContent, "4");
    assert.equal(elements["daily-completion-time"].textContent, "1m 23s");
    assert.equal(elements["daily-play-link"].textContent, "Replay today's challenge");
    await elements["daily-play-link"].dispatch("click");
    assert.equal(
        new URL(elements["daily-play-link"].href, "https://example.test").searchParams.has("first"),
        false
    );
    assert.equal(elements["daily-stat-completed"].textContent, "7");
    assert.equal(elements["daily-stat-streak"].textContent, "3");
    assert.equal(elements["daily-stat-average-moves"].textContent, "4.3");
    assert.equal(elements["daily-stat-average-time"].textContent, "1m 30s");
});

test("the same database and UTC date always produce the same ordered artists", async () => {
    const first = getRenderedChallenge(await renderDaily(
        "2035-11-12T01:00:00Z",
        createDailyDatabase(),
        { luckyConnections: "6", luckyLinkedSongs: "1" }
    ));
    const second = getRenderedChallenge(await renderDaily(
        "2035-11-12T22:00:00Z",
        createDailyDatabase(),
        { luckyConnections: "1", luckyLinkedSongs: "200" }
    ));
    const nextDay = getRenderedChallenge(await renderDaily(
        "2035-11-13T12:00:00Z",
        createDailyDatabase()
    ));

    assert.deepEqual(second, first);
    assert.notDeepEqual(
        [nextDay.start, nextDay.end],
        [first.start, first.end],
        "The date seed should be able to change the ordered challenge"
    );
});

test("daily challenge shows an error when no default-eligible pair exists", async () => {
    const database = createDailyDatabase();
    database.artistSongs[1] = database.artistSongs[1].slice(0, 24);
    database.artistSongs[3] = database.artistSongs[3].slice(0, 24);
    database.artistSongs[4] = database.artistSongs[4].slice(0, 24);
    database.artistSongs[6] = database.artistSongs[6].slice(0, 24);
    const elements = await renderDaily("2031-05-10T12:00:00Z", database);

    assert.equal(elements["daily-content"].hidden, true);
    assert.equal(elements["daily-error"].hidden, false);
    assert.equal(
        elements["daily-error-message"].textContent,
        "No daily challenge with 2 connections and at least 25 linked songs per artist could be generated."
    );
    assert.equal(elements["daily-play-link"].href, "");
});

test("one-song artists are not traversed while finding a daily route", async () => {
    const database = createDailyDatabase();
    database.songData[100] = { artists: [1, 2] };
    database.artistSongs[2] = [101];
    database.songData[101] = { artists: [2, 3] };
    database.songData[200] = { artists: [4, 5] };
    database.artistSongs[5] = [201];
    database.songData[201] = { artists: [5, 6] };
    const elements = await renderDaily("2031-05-10T12:00:00Z", database);

    assert.equal(elements["daily-content"].hidden, true);
    assert.equal(elements["daily-error"].hidden, false);
});

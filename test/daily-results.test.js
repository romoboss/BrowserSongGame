import assert from "node:assert/strict";
import test from "node:test";
import { createDatabaseFixture, installFakeDocument } from "./helpers.js";

const RESULT_ELEMENT_IDS = [
    "results-kicker",
    "challenge-summary",
    "results-content",
    "daily-result-note",
    "time-stat",
    "move-stat",
    "artist-stat",
    "unique-stat",
    "route-list",
    "replay-link",
    "results-error",
    "results-error-message"
];
let importNumber = 0;

async function renderDailyResult({
    archive = false,
    firstAttempt = !archive,
    existingCompletion = null,
    resolvedChallenge = null,
    dateKey = "2031-05-10",
    todayKey = "2031-05-10"
} = {}) {
    const elements = installFakeDocument(RESULT_ELEMENT_IDS);
    elements["results-content"].hidden = true;
    elements["results-error"].hidden = true;
    elements["daily-result-note"].hidden = true;
    globalThis.SONG_DATABASE = createDatabaseFixture();

    const persistedChallenge = resolvedChallenge || {
        dateKey,
        startId: "1",
        endId: "3",
        startName: "Persisted Start Artist",
        endName: "Persisted Target Artist",
        requiredConnections: 2,
        requiredLinkedSongs: 25,
        sourceDatabaseGeneratedAt: "2031-05-09T12:00:00Z"
    };
    const { dateKey: _resolvedDateKey, ...persistedEntry } = persistedChallenge;
    globalThis.SongavelerDailyChallenges = {
        formatVersion: 1,
        firstDate: dateKey,
        entries: {
            [dateKey]: persistedEntry
        }
    };

    const recordCalls = [];
    const resolveCalls = [];
    globalThis.SongavelerDailyGenerator = {
        isValidDateKey: candidate => candidate === dateKey,
        getUtcDateKey: () => todayKey,
        resolve(database, candidate) {
            resolveCalls.push({ database, dateKey: candidate, method: "resolve" });
            return persistedChallenge;
        },
        resolveArchive(database, candidate, today) {
            resolveCalls.push({
                database,
                dateKey: candidate,
                method: "resolveArchive",
                today
            });
            return persistedChallenge;
        }
    };
    globalThis.SongavelerDailyProgress = {
        getCompletion: () => existingCompletion,
        recordCompletion(dateKey, completion) {
            recordCalls.push([dateKey, completion]);
            return existingCompletion || completion;
        }
    };
    const parameters = new URLSearchParams({
        v: "1",
        start: "1",
        end: "3",
        elapsed: "65000",
        route: "1|100:2|101:3",
        daily: dateKey
    });
    if (archive) parameters.set("archive", "1");
    if (firstAttempt) parameters.set("first", "1");
    globalThis.location = { hash: `#${parameters}` };

    importNumber += 1;
    await import(`../js/results.js?daily-results-test=${importNumber}`);
    return { elements, recordCalls, resolveCalls };
}

test("verified current Daily Challenge results save the first completion", async () => {
    const { elements, recordCalls, resolveCalls } = await renderDailyResult();

    assert.equal(resolveCalls.length, 1);
    assert.equal(resolveCalls[0].database, globalThis.SONG_DATABASE);
    assert.equal(resolveCalls[0].dateKey, "2031-05-10");
    assert.equal(resolveCalls[0].method, "resolve");
    assert.deepEqual(recordCalls, [[
        "2031-05-10",
        { moves: 2, elapsedMs: 65_000 }
    ]]);
    assert.equal(elements["results-kicker"].textContent, "Daily Challenge complete");
    assert.equal(elements["daily-result-note"].hidden, false);
    assert.equal(
        elements["daily-result-note"].textContent,
        "Daily Challenge complete — your first result was saved to Daily Stats."
    );
    assert.equal(
        elements["replay-link"].href,
        "./game?start=1&end=3&daily=2031-05-10"
    );
});

test("archive results retain archive context and never write Daily Stats", async () => {
    const { elements, recordCalls, resolveCalls } = await renderDailyResult({
        archive: true,
        dateKey: "2031-05-09"
    });

    assert.equal(resolveCalls.length, 1);
    assert.equal(resolveCalls[0].method, "resolveArchive");
    assert.equal(resolveCalls[0].dateKey, "2031-05-09");
    assert.equal(resolveCalls[0].today, "2031-05-10");
    assert.deepEqual(recordCalls, []);
    assert.equal(elements["results-kicker"].textContent, "Archive route complete");
    assert.equal(
        elements["daily-result-note"].textContent,
        "Archive replay complete — this result was not added to your Daily Stats."
    );
    assert.equal(
        elements["replay-link"].href,
        "./game?start=1&end=3&daily=2031-05-09&archive=1"
    );
});

test("later Daily Challenge attempts leave the first result unchanged", async () => {
    const existingCompletion = { moves: 5, elapsedMs: 91_000 };
    const { elements, recordCalls } = await renderDailyResult({
        firstAttempt: false,
        existingCompletion
    });

    assert.deepEqual(recordCalls, []);
    assert.equal(
        elements["daily-result-note"].textContent,
        "Daily replay complete. Your first result remains unchanged in Daily Stats."
    );
});

test("results reject daily context when the route endpoints do not match the resolver", async () => {
    const { elements, recordCalls, resolveCalls } = await renderDailyResult({
        resolvedChallenge: {
            dateKey: "2031-05-10",
            startId: "4",
            endId: "3",
            startName: "Different Start",
            endName: "Persisted Target Artist",
            requiredConnections: 2,
            requiredLinkedSongs: 25,
            sourceDatabaseGeneratedAt: "2031-05-09T12:00:00Z"
        }
    });

    assert.equal(resolveCalls.length, 1);
    assert.deepEqual(recordCalls, []);
    assert.equal(elements["daily-result-note"].hidden, true);
    assert.equal(elements["replay-link"].href, "./game?start=1&end=3");
});

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
    existingCompletion = null
} = {}) {
    const elements = installFakeDocument(RESULT_ELEMENT_IDS);
    elements["results-content"].hidden = true;
    elements["results-error"].hidden = true;
    elements["daily-result-note"].hidden = true;
    globalThis.SONG_DATABASE = createDatabaseFixture();

    const recordCalls = [];
    globalThis.SongavelerDailyGenerator = {
        isValidDateKey: dateKey => dateKey === "2031-05-10",
        getUtcDateKey: () => "2031-05-10",
        generate: () => ({ startId: "1", endId: "3" })
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
        daily: "2031-05-10"
    });
    if (archive) parameters.set("archive", "1");
    if (firstAttempt) parameters.set("first", "1");
    globalThis.location = { hash: `#${parameters}` };

    importNumber += 1;
    await import(`../results.js?daily-results-test=${importNumber}`);
    return { elements, recordCalls };
}

test("verified current Daily Challenge results save the first completion", async () => {
    const { elements, recordCalls } = await renderDailyResult();

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
        "./game.html?start=1&end=3&daily=2031-05-10"
    );
});

test("archive results retain archive context and never write Daily Stats", async () => {
    const { elements, recordCalls } = await renderDailyResult({ archive: true });

    assert.deepEqual(recordCalls, []);
    assert.equal(elements["results-kicker"].textContent, "Archive route complete");
    assert.equal(
        elements["daily-result-note"].textContent,
        "Archive replay complete — this result was not added to your Daily Stats."
    );
    assert.equal(
        elements["replay-link"].href,
        "./game.html?start=1&end=3&daily=2031-05-10&archive=1"
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

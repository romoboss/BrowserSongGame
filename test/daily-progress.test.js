import assert from "node:assert/strict";
import test from "node:test";

const STORAGE_KEY = "songaveler-daily-progress";
let importNumber = 0;

function installStorage(initialValue) {
    const values = new Map();
    if (initialValue !== undefined) values.set(STORAGE_KEY, initialValue);

    globalThis.localStorage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value))
    };
    return values;
}

async function loadProgress() {
    importNumber += 1;
    await import(`../js/daily-progress.js?daily-progress-test=${importNumber}`);
    return globalThis.SongavelerDailyProgress;
}

test("records only the first completion for a UTC date", async () => {
    const values = installStorage();
    const progress = await loadProgress();

    assert.deepEqual(
        progress.recordCompletion("2026-08-03", { moves: 4, elapsedMs: 82_000 }),
        { moves: 4, elapsedMs: 82_000 }
    );
    assert.deepEqual(
        progress.recordCompletion("2026-08-03", { moves: 2, elapsedMs: 10_000 }),
        { moves: 4, elapsedMs: 82_000 }
    );
    assert.deepEqual(progress.getCompletion("2026-08-03"), {
        moves: 4,
        elapsedMs: 82_000
    });
    assert.deepEqual(JSON.parse(values.get(STORAGE_KEY)), {
        version: 1,
        attempts: { "2026-08-03": true },
        completions: {
            "2026-08-03": { moves: 4, elapsedMs: 82_000 }
        }
    });
});

test("claims only the first started attempt for each date", async () => {
    const values = installStorage();
    const progress = await loadProgress();

    assert.equal(progress.claimFirstAttempt("2026-08-03"), true);
    assert.equal(progress.claimFirstAttempt("2026-08-03"), false);
    assert.equal(progress.claimFirstAttempt("2026-08-04"), true);
    assert.equal(progress.claimFirstAttempt("not-a-date"), false);
    assert.deepEqual(JSON.parse(values.get(STORAGE_KEY)).attempts, {
        "2026-08-03": true,
        "2026-08-04": true
    });
});

test("calculates totals, averages, and the current UTC streak", async () => {
    installStorage();
    const progress = await loadProgress();

    progress.recordCompletion("2027-01-25", { moves: 8, elapsedMs: 200_000 });
    progress.recordCompletion("2028-02-28", { moves: 2, elapsedMs: 40_000 });
    progress.recordCompletion("2028-02-29", { moves: 3, elapsedMs: 50_000 });
    progress.recordCompletion("2028-03-01", { moves: 7, elapsedMs: 110_000 });

    assert.deepEqual(progress.getStats("2028-03-01"), {
        completedCount: 4,
        currentStreak: 3,
        averageMoves: 5,
        averageElapsedMs: 100_000
    });
    assert.equal(
        progress.getStats("2028-03-02").currentStreak,
        3,
        "A streak ending yesterday remains current while today's challenge is unfinished"
    );
    assert.equal(progress.getStats("2028-03-03").currentStreak, 0);
});

test("returns empty data for missing, corrupt, or unsupported stored schemas", async () => {
    const corruptValues = installStorage("not json");
    let progress = await loadProgress();

    assert.equal(progress.getCompletion("2026-08-03"), null);
    assert.deepEqual(progress.getStats("2026-08-03"), {
        completedCount: 0,
        currentStreak: 0,
        averageMoves: null,
        averageElapsedMs: null
    });
    progress.recordCompletion("2026-08-03", { moves: 3, elapsedMs: 1_000 });
    assert.equal(JSON.parse(corruptValues.get(STORAGE_KEY)).version, 1);

    installStorage(JSON.stringify({
        version: 2,
        completions: { "2026-08-03": { moves: 3, elapsedMs: 1_000 } }
    }));
    progress = await loadProgress();
    assert.equal(progress.getCompletion("2026-08-03"), null);
});

test("migrates completion-only version 1 data into claimed attempts", async () => {
    const values = installStorage(JSON.stringify({
        version: 1,
        completions: { "2026-08-03": { moves: 3, elapsedMs: 1_000 } }
    }));
    const progress = await loadProgress();

    assert.equal(progress.claimFirstAttempt("2026-08-03"), false);
    assert.equal(progress.claimFirstAttempt("2026-08-04"), true);
    assert.equal(JSON.parse(values.get(STORAGE_KEY)).attempts["2026-08-03"], true);
});

test("rejects invalid dates and metrics without changing storage", async () => {
    const values = installStorage();
    const progress = await loadProgress();

    assert.equal(progress.getCompletion("2026-02-30"), null);
    assert.equal(progress.getStats("03-08-2026"), null);
    assert.equal(progress.recordCompletion("2026-02-30", { moves: 2, elapsedMs: 5_000 }), null);
    assert.equal(progress.recordCompletion("2026-08-03", { moves: 0, elapsedMs: 5_000 }), null);
    assert.equal(progress.recordCompletion("2026-08-03", { moves: 2, elapsedMs: -1 }), null);
    assert.equal(progress.recordCompletion("2026-08-03", { moves: 2.5, elapsedMs: 5_000 }), null);
    assert.equal(values.has(STORAGE_KEY), false);
});

test("stores no extra input fields and stays usable without browser storage", async () => {
    globalThis.localStorage = {
        getItem() {
            throw new Error("storage denied");
        },
        setItem() {
            throw new Error("storage denied");
        }
    };
    const progress = await loadProgress();

    const result = progress.recordCompletion("2026-08-03", {
        moves: 3,
        elapsedMs: 90_000,
        email: "not-stored@example.test"
    });

    assert.deepEqual(result, { moves: 3, elapsedMs: 90_000 });
    assert.deepEqual(progress.getCompletion("2026-08-03"), {
        moves: 3,
        elapsedMs: 90_000
    });
    assert.deepEqual(progress.getStats("2026-08-03"), {
        completedCount: 1,
        currentStreak: 1,
        averageMoves: 3,
        averageElapsedMs: 90_000
    });
});

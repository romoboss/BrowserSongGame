(() => {
    "use strict";

    const STORAGE_KEY = "songaveler-daily-progress";
    const SCHEMA_VERSION = 1;
    let fallbackState = createEmptyState();

    function createEmptyState() {
        return { version: SCHEMA_VERSION, attempts: {}, completions: {} };
    }

    function isPlainObject(value) {
        return value !== null
            && typeof value === "object"
            && !Array.isArray(value);
    }

    function isValidDateKey(value) {
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            return false;
        }

        const date = new Date(`${value}T00:00:00.000Z`);
        return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }

    function isValidMetric(value, minimum) {
        return Number.isSafeInteger(value) && value >= minimum;
    }

    function isValidCompletion(value) {
        if (!isPlainObject(value)) return false;

        const keys = Object.keys(value).sort();
        return keys.length === 2
            && keys[0] === "elapsedMs"
            && keys[1] === "moves"
            && isValidMetric(value.moves, 1)
            && isValidMetric(value.elapsedMs, 0);
    }

    function normalizeState(value) {
        if (!isPlainObject(value)
            || value.version !== SCHEMA_VERSION
            || !isPlainObject(value.completions)) {
            return null;
        }

        const keys = Object.keys(value).sort();
        const isLegacy = keys.length === 2
            && keys[0] === "completions"
            && keys[1] === "version";
        const hasAttempts = keys.length === 3
            && keys[0] === "attempts"
            && keys[1] === "completions"
            && keys[2] === "version"
            && isPlainObject(value.attempts);
        if (!isLegacy && !hasAttempts) return null;

        if (!Object.entries(value.completions).every(
            ([dateKey, completion]) => isValidDateKey(dateKey) && isValidCompletion(completion)
        )) {
            return null;
        }

        const attempts = isLegacy
            ? Object.fromEntries(Object.keys(value.completions).map(dateKey => [dateKey, true]))
            : value.attempts;
        if (!Object.entries(attempts).every(
            ([dateKey, attempted]) => isValidDateKey(dateKey) && attempted === true
        )) {
            return null;
        }

        return copyState({
            version: SCHEMA_VERSION,
            attempts,
            completions: value.completions
        });
    }

    function copyCompletion(completion) {
        return completion
            ? { moves: completion.moves, elapsedMs: completion.elapsedMs }
            : null;
    }

    function copyState(state) {
        const attempts = { ...state.attempts };
        const completions = {};
        for (const [dateKey, completion] of Object.entries(state.completions)) {
            completions[dateKey] = copyCompletion(completion);
        }
        return { version: SCHEMA_VERSION, attempts, completions };
    }

    function readState() {
        try {
            const serialized = globalThis.localStorage?.getItem(STORAGE_KEY);
            if (serialized === null || serialized === undefined) {
                return copyState(fallbackState);
            }

            const parsed = JSON.parse(serialized);
            const normalized = normalizeState(parsed);
            if (!normalized) return createEmptyState();

            fallbackState = copyState(normalized);
            return copyState(normalized);
        } catch {
            return copyState(fallbackState);
        }
    }

    function writeState(state) {
        fallbackState = copyState(state);
        try {
            globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch {
            // Keep the completion available for this page when storage is unavailable.
        }
    }

    function getCompletion(dateKey) {
        if (!isValidDateKey(dateKey)) return null;
        return copyCompletion(readState().completions[dateKey]);
    }

    function claimFirstAttempt(dateKey) {
        if (!isValidDateKey(dateKey)) return false;

        const state = readState();
        if (state.attempts[dateKey]) return false;

        state.attempts[dateKey] = true;
        writeState(state);
        return true;
    }

    function recordCompletion(dateKey, result) {
        if (!isValidDateKey(dateKey) || !isPlainObject(result)) return null;

        const completion = {
            moves: result.moves,
            elapsedMs: result.elapsedMs
        };
        if (!isValidCompletion(completion)) return null;

        const state = readState();
        const existing = state.completions[dateKey];
        if (existing) return copyCompletion(existing);

        state.attempts[dateKey] = true;
        state.completions[dateKey] = completion;
        writeState(state);
        return copyCompletion(completion);
    }

    function previousUtcDate(dateKey) {
        const date = new Date(`${dateKey}T00:00:00.000Z`);
        date.setUTCDate(date.getUTCDate() - 1);
        return date.toISOString().slice(0, 10);
    }

    function getStats(todayDate) {
        if (!isValidDateKey(todayDate)) return null;

        const completions = readState().completions;
        const entries = Object.values(completions);
        let currentStreak = 0;
        let cursor = completions[todayDate] ? todayDate : previousUtcDate(todayDate);

        while (completions[cursor]) {
            currentStreak += 1;
            cursor = previousUtcDate(cursor);
        }

        const totals = entries.reduce((result, completion) => ({
            moves: result.moves + completion.moves,
            elapsedMs: result.elapsedMs + completion.elapsedMs
        }), { moves: 0, elapsedMs: 0 });

        return {
            completedCount: entries.length,
            currentStreak,
            averageMoves: entries.length > 0 ? totals.moves / entries.length : null,
            averageElapsedMs: entries.length > 0 ? totals.elapsedMs / entries.length : null
        };
    }

    globalThis.SongavelerDailyProgress = Object.freeze({
        claimFirstAttempt,
        getCompletion,
        recordCompletion,
        getStats
    });
})();

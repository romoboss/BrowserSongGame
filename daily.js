(() => {
    "use strict";

    const database = globalThis.SONG_DATABASE;
    const generator = globalThis.SongavelerDailyGenerator;
    const progress = globalThis.SongavelerDailyProgress;
    const elementIds = [
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

    if (!globalThis.document) return;

    const elements = Object.fromEntries(
        elementIds.map(id => [id, document.getElementById(id)])
    );
    const missingIds = elementIds.filter(id => !elements[id]);

    if (missingIds.length > 0) {
        console.error(`The daily challenge page is missing: ${missingIds.join(", ")}.`);
        return;
    }

    function formatDuration(milliseconds) {
        if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
        if (milliseconds < 1000) return `${(milliseconds / 1000).toFixed(1)}s`;

        const totalSeconds = Math.floor(milliseconds / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
        if (minutes > 0) return `${minutes}m ${seconds}s`;
        return `${seconds}s`;
    }

    function formatAverage(value) {
        if (!Number.isFinite(value)) return "—";
        return Number.isInteger(value) ? String(value) : value.toFixed(1);
    }

    function renderProgress(dateKey) {
        const completion = progress?.getCompletion?.(dateKey) || null;
        const stats = progress?.getStats?.(dateKey) || {
            completedCount: 0,
            currentStreak: 0,
            averageMoves: null,
            averageElapsedMs: null
        };

        elements["daily-completion"].hidden = !completion;
        if (completion) {
            elements["daily-completion-moves"].textContent = String(completion.moves);
            elements["daily-completion-time"].textContent = formatDuration(completion.elapsedMs);
            elements["daily-play-link"].textContent = "Replay today's challenge";
        }

        elements["daily-stat-completed"].textContent = String(stats.completedCount || 0);
        elements["daily-stat-streak"].textContent = String(stats.currentStreak || 0);
        elements["daily-stat-average-moves"].textContent = formatAverage(stats.averageMoves);
        elements["daily-stat-average-time"].textContent = formatDuration(stats.averageElapsedMs);
    }

    function showError(message) {
        elements["daily-content"].hidden = true;
        elements["daily-error"].hidden = false;
        elements["daily-error-message"].textContent = message;
    }

    function initialize() {
        if (!generator) {
            showError("The daily challenge generator could not be loaded.");
            return;
        }

        const dateKey = generator.getUtcDateKey();
        elements["daily-date"].textContent = dateKey;
        elements["daily-date"].setAttribute("datetime", dateKey);
        renderProgress(dateKey);

        let challenge;
        try {
            challenge = generator.generate(database, dateKey);
        } catch {
            showError("The bundled artist database could not be loaded.");
            return;
        }

        if (!challenge) {
            showError(
                "No daily challenge with 2 connections and at least 25 linked songs "
                + "per artist could be generated."
            );
            return;
        }

        const parameters = new URLSearchParams({
            start: challenge.startId,
            end: challenge.endId,
            daily: dateKey
        });

        elements["daily-start-artist"].textContent = database.artists[challenge.startId];
        elements["daily-end-artist"].textContent = database.artists[challenge.endId];
        elements["daily-status"].textContent =
            "Today’s artists are 2 connections apart and each have at least 25 linked songs.";
        elements["daily-play-link"].href = `./game?${parameters}`;
        elements["daily-play-link"].addEventListener("click", () => {
            const attemptParameters = new URLSearchParams(parameters);
            if (progress?.claimFirstAttempt?.(dateKey) === true) {
                attemptParameters.set("first", "1");
            }
            elements["daily-play-link"].href = `./game?${attemptParameters}`;
        }, { once: true });
        elements["daily-content"].hidden = false;
        elements["daily-error"].hidden = true;
        elements["daily-error-message"].textContent = "";
    }

    initialize();
})();

(() => {
    "use strict";

    const elementIds = [
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

    if (!globalThis.document) return;

    function initializeArchive() {
        const elements = Object.fromEntries(
            elementIds.map(id => [id, document.getElementById(id)])
        );
        const missingIds = elementIds.filter(id => !elements[id]);

        if (missingIds.length > 0) {
            console.error(`The challenge archive page is missing: ${missingIds.join(", ")}.`);
            return;
        }

        const generator = globalThis.SongavelerDailyGenerator;
        const today = generator?.getUtcDateKey?.() || new Date().toISOString().slice(0, 10);
        let bounds = null;
        let challengeRequestNumber = 0;

        async function loadDatabase() {
            if (globalThis.SONG_DATABASE) return globalThis.SONG_DATABASE;
            await Promise.all([
                globalThis.SONG_ROUTE_DATABASE
                    ? Promise.resolve()
                    : import("../data/route-database.js?v=20260814T212403"),
                globalThis.SONG_ROUTE_GRAPH
                    ? Promise.resolve()
                    : import("../data/route-graph.js?v=2026-08-14T21%3A24%3A03Z")
            ]);

            const routeDatabase = globalThis.SONG_ROUTE_DATABASE;
            const routeGraph = globalThis.SONG_ROUTE_GRAPH;
            if (
                !routeDatabase
                || !routeGraph
                || routeDatabase.graphVersion !== routeGraph.version
            ) {
                throw new Error("The compact route database is unavailable.");
            }
            return { ...routeDatabase, adjacency: routeGraph.adjacency };
        }

        function getArtistName(database, artistId) {
            const fullDatabaseName = database?.artists?.[artistId];
            if (fullDatabaseName) return fullDatabaseName;
            const record = database?.records?.find(row => String(row[0]) === String(artistId));
            return record?.[1] || null;
        }

        function hasArtist(database, artistId) {
            if (database?.artists) return Boolean(database.artists[artistId]);
            if (database?.records) {
                return database.records.some(row => String(row[0]) === String(artistId));
            }
            return true;
        }

        function showError(message) {
            elements["archive-content"].hidden = true;
            elements["archive-error"].hidden = false;
            elements["archive-error"].textContent = message;
            elements["archive-play-link"].removeAttribute("href");
            elements["archive-play-link"].href = "";
        }

        async function showChallenge(dateKey) {
            const requestNumber = ++challengeRequestNumber;
            if (!generator) {
                showError("The daily challenge generator could not be loaded.");
                return;
            }

            if (!generator.isValidDateKey(dateKey)) {
                showError("Enter a real date in YYYY-MM-DD format.");
                return;
            }

            if (!bounds || dateKey < bounds.firstDate) {
                showError(
                    bounds
                        ? `Challenges are available from ${bounds.firstDate}.`
                        : "The Daily Challenge archive is unavailable."
                );
                return;
            }

            if (dateKey > bounds.maxArchiveDate) {
                showError(`Choose a date no later than ${bounds.maxArchiveDate}.`);
                return;
            }

            let challenge;
            let database = globalThis.SONG_DATABASE;
            try {
                if (dateKey > bounds.lastSavedDate) database ||= await loadDatabase();
                challenge = generator.resolveArchive(database, dateKey, today);
            } catch {
                if (requestNumber === challengeRequestNumber) {
                    showError("The Daily Challenge archive could not be loaded.");
                }
                return;
            }
            if (requestNumber !== challengeRequestNumber) return;

            if (!challenge) {
                showError(
                    "No archived challenge with 2 connections and at least 25 linked songs "
                    + "per artist could be generated."
                );
                return;
            }

            const startName = challenge.startName || getArtistName(database, challenge.startId);
            const endName = challenge.endName || getArtistName(database, challenge.endId);
            if (
                !startName
                || !endName
                || !hasArtist(database, challenge.startId)
                || !hasArtist(database, challenge.endId)
            ) {
                showError("This archived challenge is no longer playable in the bundled database.");
                return;
            }

            const parameters = new URLSearchParams({
                start: challenge.startId,
                end: challenge.endId,
                daily: dateKey,
                archive: "1"
            });

            elements["archive-date-output"].textContent = dateKey;
            elements["archive-date-output"].setAttribute("datetime", dateKey);
            elements["archive-start-artist"].textContent = startName;
            elements["archive-end-artist"].textContent = endName;
            elements["archive-status"].textContent =
                "Saved artist pairs stay fixed across database updates. Archive replays do not affect your stats.";
            elements["archive-play-link"].href = `./game?${parameters}`;
            elements["archive-content"].hidden = false;
            elements["archive-error"].hidden = true;
            elements["archive-error"].textContent = "";
        }

        elements["archive-form"].addEventListener("submit", event => {
            event.preventDefault();
            return showChallenge(elements["archive-date-input"].value);
        });

        try {
            bounds = generator?.getBounds?.(today) || null;
        } catch {
            showError("The Daily Challenge archive could not be loaded.");
            return;
        }

        if (!bounds || bounds.maxArchiveDate < bounds.firstDate) {
            showError("No past Daily Challenges are available yet.");
            return;
        }

        elements["archive-date-input"].setAttribute("min", bounds.firstDate);
        elements["archive-date-input"].setAttribute("max", bounds.maxArchiveDate);
        elements["archive-date-input"].min = bounds.firstDate;
        elements["archive-date-input"].max = bounds.maxArchiveDate;
        elements["archive-date-input"].value = bounds.maxArchiveDate;
        void showChallenge(bounds.maxArchiveDate);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initializeArchive, { once: true });
    } else {
        initializeArchive();
    }
})();

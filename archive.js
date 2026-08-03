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
        const database = globalThis.SONG_DATABASE;

        function showError(message) {
            elements["archive-content"].hidden = true;
            elements["archive-error"].hidden = false;
            elements["archive-error"].textContent = message;
        }

        function showChallenge(dateKey) {
            if (!generator) {
                showError("The daily challenge generator could not be loaded.");
                return;
            }

            if (!generator.isValidDateKey(dateKey)) {
                showError("Enter a real date in YYYY-MM-DD format.");
                return;
            }

            let challenge;
            try {
                challenge = generator.generate(database, dateKey);
            } catch {
                showError("The bundled artist database could not be loaded.");
                return;
            }

            if (!challenge) {
                showError(
                    "No archived challenge with 2 connections and at least 25 linked songs "
                    + "per artist could be generated."
                );
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
            elements["archive-start-artist"].textContent = database.artists[challenge.startId];
            elements["archive-end-artist"].textContent = database.artists[challenge.endId];
            elements["archive-status"].textContent =
                "Archive replays use the default Daily Challenge rules and do not affect your stats.";
            elements["archive-play-link"].href = `./game?${parameters}`;
            elements["archive-content"].hidden = false;
            elements["archive-error"].hidden = true;
            elements["archive-error"].textContent = "";
        }

        elements["archive-form"].addEventListener("submit", event => {
            event.preventDefault();
            showChallenge(elements["archive-date-input"].value);
        });

        const today = generator?.getUtcDateKey() || new Date().toISOString().slice(0, 10);
        elements["archive-date-input"].value = today;
        showChallenge(today);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initializeArchive, { once: true });
    } else {
        initializeArchive();
    }
})();

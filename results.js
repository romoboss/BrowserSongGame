const database = globalThis.SONG_DATABASE;
const dailyGenerator = globalThis.SongavelerDailyGenerator;
const dailyProgress = globalThis.SongavelerDailyProgress;

const kickerElement = document.getElementById("results-kicker");
const summaryElement = document.getElementById("challenge-summary");
const contentElement = document.getElementById("results-content");
const dailyResultNoteElement = document.getElementById("daily-result-note");
const timeElement = document.getElementById("time-stat");
const moveElement = document.getElementById("move-stat");
const artistElement = document.getElementById("artist-stat");
const uniqueElement = document.getElementById("unique-stat");
const routeElement = document.getElementById("route-list");
const replayLink = document.getElementById("replay-link");
const errorElement = document.getElementById("results-error");
const errorMessageElement = document.getElementById("results-error-message");

function getArtist(id) {
    const name = database.artists[id];
    return name ? { id: String(id), name } : null;
}

function getSong(id) {
    const title = database.songs[id];
    const record = database.songData[id];
    return title && record?.artists
        ? { id: String(id), title, artistIds: record.artists.map(String) }
        : null;
}

function formatDuration(milliseconds) {
    if (milliseconds < 1000) return `${(milliseconds / 1000).toFixed(1)}s`;

    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

function parseRoute(encodedRoute) {
    const pieces = encodedRoute.split("|").filter(Boolean);
    if (pieces.length === 0 || pieces.length > 1000) return null;

    const firstArtist = getArtist(pieces[0]);
    if (!firstArtist) return null;

    const parsedRoute = [{ artist: firstArtist, song: null }];
    let previousArtistId = firstArtist.id;

    for (const piece of pieces.slice(1)) {
        const [songId, artistId, extra] = piece.split(":");
        if (!songId || !artistId || extra !== undefined) return null;

        const song = getSong(songId);
        const artist = getArtist(artistId);
        if (
            !song
            || !artist
            || !song.artistIds.includes(previousArtistId)
            || !song.artistIds.includes(artist.id)
        ) {
            return null;
        }

        parsedRoute.push({ artist, song });
        previousArtistId = artist.id;
    }

    return parsedRoute;
}

function showError(message) {
    contentElement.hidden = true;
    errorElement.hidden = false;
    errorMessageElement.textContent = message;
}

function renderRoute(route) {
    routeElement.replaceChildren();

    for (const [index, step] of route.entries()) {
        const item = document.createElement("li");
        const node = document.createElement("div");
        const label = document.createElement("span");
        const artist = document.createElement("strong");
        const song = document.createElement("span");

        item.classList.add("route-step");
        item.classList.add(index === 0 ? "is-start" : "is-move");
        if (index === route.length - 1) item.classList.add("is-finish");
        node.classList.add("route-node");
        label.classList.add("route-step-label");
        label.textContent = index === 0
            ? "Start"
            : index === route.length - 1
                ? "Finish"
                : `Move ${index}`;
        artist.classList.add("route-artist");
        artist.textContent = step.artist.name;
        song.classList.add("route-song");
        song.textContent = index === 0 ? "Starting artist" : `via ${step.song.title}`;

        node.appendChild(label);
        node.appendChild(artist);
        node.appendChild(song);
        item.appendChild(node);
        routeElement.appendChild(item);
    }
}

function getDailyContext(parameters, startId, endId) {
    const dateKey = parameters.get("daily");
    if (!dailyGenerator?.isValidDateKey?.(dateKey)) return null;

    let challenge;
    try {
        challenge = dailyGenerator.generate(database, dateKey);
    } catch {
        return null;
    }

    if (!challenge || challenge.startId !== startId || challenge.endId !== endId) return null;

    const isToday = dailyGenerator.getUtcDateKey() === dateKey;
    return {
        dateKey,
        isArchive: parameters.get("archive") === "1" || !isToday,
        isFirstAttempt: parameters.get("first") === "1" && isToday
    };
}

function renderDailyResult(context, moves, elapsed) {
    if (!context) return;

    dailyResultNoteElement.hidden = false;
    if (context.isArchive) {
        kickerElement.textContent = "Archive route complete";
        dailyResultNoteElement.dataset.kind = "archive";
        dailyResultNoteElement.textContent =
            "Archive replay complete — this result was not added to your Daily Stats.";
        return;
    }

    kickerElement.textContent = "Daily Challenge complete";
    dailyResultNoteElement.dataset.kind = "daily";
    const firstCompletion = dailyProgress?.getCompletion?.(context.dateKey) || null;
    if (!context.isFirstAttempt) {
        dailyResultNoteElement.textContent = firstCompletion
            ? "Daily replay complete. Your first result remains unchanged in Daily Stats."
            : "Daily Challenge complete, but only the first attempt counts, so this result was not added to Daily Stats.";
        return;
    }

    const savedCompletion = dailyProgress?.recordCompletion?.(
        context.dateKey,
        { moves, elapsedMs: Math.floor(elapsed) }
    ) || null;

    if (!savedCompletion) {
        dailyResultNoteElement.textContent =
            "Daily Challenge complete. This browser could not save the result to Daily Stats.";
    } else if (firstCompletion) {
        dailyResultNoteElement.textContent =
            "Daily replay complete. Your first result remains unchanged in Daily Stats.";
    } else {
        dailyResultNoteElement.textContent =
            "Daily Challenge complete — your first result was saved to Daily Stats.";
    }
}

function initialize() {
    if (!database?.artists || !database?.songs || !database?.songData) {
        showError("The bundled song database is unavailable.");
        return;
    }

    const parameters = new URLSearchParams((globalThis.location.hash || "").replace(/^#/, ""));
    const startId = parameters.get("start");
    const endId = parameters.get("end");
    const elapsedValue = parameters.get("elapsed");
    const elapsed = Number(elapsedValue);
    const route = parseRoute(parameters.get("route") || "");
    const startArtist = getArtist(startId);
    const endArtist = getArtist(endId);

    if (
        parameters.get("v") !== "1"
        || !startArtist
        || !endArtist
        || startArtist.id === endArtist.id
        || elapsedValue === null
        || !Number.isFinite(elapsed)
        || elapsed < 0
        || !route
        || route[0].artist.id !== startArtist.id
        || route.at(-1).artist.id !== endArtist.id
    ) {
        showError("The route data is missing, incomplete, or invalid.");
        return;
    }

    const moves = route.length - 1;
    const uniqueArtists = new Set(route.map(step => step.artist.id)).size;
    const dailyContext = getDailyContext(parameters, startId, endId);
    const replayParameters = new URLSearchParams({ start: startId, end: endId });
    if (dailyContext) {
        replayParameters.set("daily", dailyContext.dateKey);
        if (dailyContext.isArchive) replayParameters.set("archive", "1");
    }

    summaryElement.textContent = `${startArtist.name} to ${endArtist.name}`;
    timeElement.textContent = formatDuration(elapsed);
    moveElement.textContent = String(moves);
    artistElement.textContent = String(route.length);
    uniqueElement.textContent = String(uniqueArtists);
    replayLink.href = `./game?${replayParameters}`;
    document.title = `${startArtist.name} to ${endArtist.name} - Results`;

    renderDailyResult(dailyContext, moves, elapsed);
    renderRoute(route);
    errorElement.hidden = true;
    contentElement.hidden = false;
}

const missingElements = [
    ["results-kicker", kickerElement],
    ["challenge-summary", summaryElement],
    ["results-content", contentElement],
    ["daily-result-note", dailyResultNoteElement],
    ["time-stat", timeElement],
    ["move-stat", moveElement],
    ["artist-stat", artistElement],
    ["unique-stat", uniqueElement],
    ["route-list", routeElement],
    ["replay-link", replayLink],
    ["results-error", errorElement],
    ["results-error-message", errorMessageElement]
].filter(([, element]) => !element).map(([id]) => id);

if (missingElements.length > 0) {
    console.error(`The results page is missing: ${missingElements.join(", ")}.`);
} else {
    initialize();
}

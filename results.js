const database = globalThis.SONG_DATABASE;

const summaryElement = document.getElementById("challenge-summary");
const contentElement = document.getElementById("results-content");
const timeElement = document.getElementById("time-stat");
const moveElement = document.getElementById("move-stat");
const artistElement = document.getElementById("artist-stat");
const uniqueElement = document.getElementById("unique-stat");
const routeElement = document.getElementById("route-list");
const replayLink = document.getElementById("replay-link");
const errorElement = document.getElementById("results-error");
const errorMessageElement = document.getElementById("results-error-message");

function getMaximumSuggestions() {
    const resultLimit = Number(document.documentElement.dataset.resultLimit);
    return Number.isInteger(resultLimit) && resultLimit >= 1 && resultLimit <= 25
        ? resultLimit
        : 10;
}

function getUiTransparency() {
    const transparency = Number(document.documentElement.dataset.uiTransparency);
    return Number.isInteger(transparency) && transparency >= 0 && transparency <= 80
        ? transparency
        : 48;
}

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
        const artist = document.createElement("span");
        const song = document.createElement("span");

        item.classList.add("route-step");
        artist.classList.add("route-artist");
        artist.textContent = step.artist.name;
        song.classList.add("route-song");
        song.textContent = index === 0 ? "Starting artist" : `via ${step.song.title}`;

        item.appendChild(artist);
        item.appendChild(song);
        routeElement.appendChild(item);
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

    summaryElement.textContent = `${startArtist.name} to ${endArtist.name}`;
    timeElement.textContent = formatDuration(elapsed);
    moveElement.textContent = String(moves);
    artistElement.textContent = String(route.length);
    uniqueElement.textContent = String(uniqueArtists);
    replayLink.href = `./game.html?${new URLSearchParams({
        start: startId,
        end: endId,
        theme: document.documentElement.dataset.theme || "white",
        limit: String(getMaximumSuggestions()),
        transparency: String(getUiTransparency())
    })}`;
    document.title = `${startArtist.name} to ${endArtist.name} - Results`;

    renderRoute(route);
    errorElement.hidden = true;
    contentElement.hidden = false;
}

const missingElements = [
    ["challenge-summary", summaryElement],
    ["results-content", contentElement],
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

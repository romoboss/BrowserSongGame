const database = globalThis.SONG_DATABASE;

const startArtistElement = document.getElementById("start-artist");
const targetArtistElement = document.getElementById("target-artist");
const artistElement = document.getElementById("artist");
const searchInput = document.getElementById("search");
const suggestionsElement = document.getElementById("song-suggestions");
const choicesElement = document.getElementById("choices");
const statusElement = document.getElementById("status");
const moveCountElement = document.getElementById("move-count");
const timerElement = document.getElementById("timer");
const routePreviewElement = document.getElementById("route-preview");
const restartButton = document.getElementById("restart-challenge");

let startArtist = null;
let targetArtist = null;
let currentArtist = null;
let currentSuggestions = [];
let activeSuggestionIndex = -1;
let route = [];
let startedAt = 0;
let timerHandle = null;

function normalize(value) {
    return String(value)
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase()
        .trim();
}

function setStatus(message, isError = false) {
    statusElement.textContent = message;
    statusElement.dataset.error = String(isError);
}

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

    if (!title || !record?.artists) return null;

    return {
        id: String(id),
        title,
        artists: record.artists.map(getArtist).filter(Boolean)
    };
}

function findReachableArtists(startId) {
    const startKey = String(startId);
    const reachable = new Set();
    const traversed = new Set([startKey]);
    const queue = [startKey];

    while (queue.length > 0) {
        const artistId = queue.shift();
        for (const songId of database.artistSongs[artistId] || []) {
            for (const nextArtistId of database.songData[songId]?.artists || []) {
                const nextId = String(nextArtistId);
                if (nextId === startKey) continue;

                reachable.add(nextId);
                if (!traversed.has(nextId) && (database.artistSongs[nextId] || []).length !== 1) {
                    traversed.add(nextId);
                    queue.push(nextId);
                }
            }
        }
    }

    return reachable;
}

function closeSuggestions() {
    currentSuggestions = [];
    activeSuggestionIndex = -1;
    suggestionsElement.replaceChildren();
    suggestionsElement.hidden = true;
    searchInput.setAttribute("aria-expanded", "false");
    searchInput.removeAttribute("aria-activedescendant");
}

function setActiveSuggestion(index) {
    if (currentSuggestions.length === 0) return;

    activeSuggestionIndex = (index + currentSuggestions.length) % currentSuggestions.length;
    for (const [suggestionIndex, element] of [...suggestionsElement.children].entries()) {
        const active = suggestionIndex === activeSuggestionIndex;
        element.classList.toggle("active", active);
        element.setAttribute("aria-selected", String(active));
    }
    searchInput.setAttribute("aria-activedescendant", `song-suggestion-${activeSuggestionIndex}`);
}

function formatTimer(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function updateTimer() {
    timerElement.textContent = formatTimer(Date.now() - startedAt);
}

function renderRoutePreview() {
    routePreviewElement.replaceChildren();

    for (const step of route) {
        const item = document.createElement("li");
        const artist = getArtist(step.artistId);
        item.textContent = artist?.name || "Unknown artist";
        if (step.songId) item.title = `via ${database.songs[step.songId]}`;
        routePreviewElement.appendChild(item);
    }
}

function encodeRoute() {
    return route
        .map((step, index) => index === 0 ? step.artistId : `${step.songId}:${step.artistId}`)
        .join("|");
}

function finishGame() {
    if (timerHandle !== null) clearInterval(timerHandle);

    const parameters = new URLSearchParams({
        v: "1",
        start: startArtist.id,
        end: targetArtist.id,
        elapsed: String(Math.max(0, Date.now() - startedAt)),
        route: encodeRoute()
    });
    const theme = document.documentElement.dataset.theme || "white";
    const pageParameters = new URLSearchParams({
        theme,
        limit: String(getMaximumSuggestions()),
        transparency: String(getUiTransparency())
    });
    const resultsUrl = `./results.html?${pageParameters}#${parameters}`;

    if (typeof globalThis.location.replace === "function") {
        globalThis.location.replace(resultsUrl);
    } else {
        globalThis.location.href = resultsUrl;
    }
}

function selectArtist(artist, song = null) {
    if (song) route.push({ songId: song.id, artistId: artist.id });

    currentArtist = artist;
    artistElement.textContent = artist.name;
    moveCountElement.textContent = `${route.length - 1} move${route.length === 2 ? "" : "s"}`;
    choicesElement.replaceChildren();
    searchInput.value = "";
    closeSuggestions();
    renderRoutePreview();

    if (artist.id === targetArtist.id) {
        finishGame();
        return;
    }

    searchInput.focus();
    setStatus(`Start typing to find a song by ${artist.name}.`);
}

function showArtistChoices(song) {
    choicesElement.replaceChildren();
    const nextArtists = song.artists.filter(artist => artist.id !== currentArtist.id);

    if (nextArtists.length === 0) {
        setStatus(`${song.title} has no other credited artists in the database.`);
        return;
    }

    let enabledArtistCount = 0;

    for (const artist of nextArtists) {
        const linkedSongCount = (database.artistSongs[artist.id] || []).length;
        const isTarget = artist.id === targetArtist.id;
        const isDeadEnd = linkedSongCount === 1 && !isTarget;
        const button = document.createElement("button");

        button.type = "button";
        button.textContent = artist.name;
        button.dataset.artistId = artist.id;
        button.disabled = isDeadEnd;

        if (isTarget) {
            button.classList.add("target-choice");
            button.title = `Complete the challenge with ${artist.name}`;
        }

        if (isDeadEnd) {
            button.classList.add("dead-end");
            button.title = `${artist.name} has only one linked song`;
        } else {
            enabledArtistCount += 1;
            button.addEventListener("click", () => selectArtist(artist, song));
        }

        choicesElement.appendChild(button);
    }

    setStatus(
        enabledArtistCount === 0
            ? `All artists connected by ${song.title} are dead ends.`
            : `Choose an artist connected by ${song.title}.`
    );
}

function chooseSuggestion(song) {
    searchInput.value = song.title;
    closeSuggestions();
    showArtistChoices(song);
}

function renderSuggestions(matches, totalMatches) {
    suggestionsElement.replaceChildren();
    currentSuggestions = matches;
    activeSuggestionIndex = -1;

    for (const [index, song] of matches.entries()) {
        const button = document.createElement("button");
        const title = document.createElement("span");
        const artists = document.createElement("span");

        button.id = `song-suggestion-${index}`;
        button.type = "button";
        button.classList.add("suggestion");
        button.dataset.songId = song.id;
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", "false");

        title.classList.add("suggestion-title");
        title.textContent = song.title;
        artists.classList.add("suggestion-artists");
        artists.textContent = song.artists.map(artist => artist.name).join(" - ");

        button.appendChild(title);
        button.appendChild(artists);
        button.addEventListener("mouseenter", () => setActiveSuggestion(index));
        button.addEventListener("mousedown", event => event.preventDefault());
        button.addEventListener("click", () => chooseSuggestion(song));
        suggestionsElement.appendChild(button);
    }

    suggestionsElement.hidden = false;
    searchInput.setAttribute("aria-expanded", "true");
    const suffix = totalMatches > matches.length ? ` Showing the first ${matches.length}.` : "";
    setStatus(`${totalMatches} matching song${totalMatches === 1 ? "" : "s"}.${suffix}`);
}

function updateSuggestions() {
    if (!currentArtist) return;

    const originalQuery = searchInput.value.trim();
    const query = normalize(originalQuery);
    choicesElement.replaceChildren();

    if (!query) {
        closeSuggestions();
        setStatus(`Start typing to find a song by ${currentArtist.name}.`);
        return;
    }

    const matches = (database.artistSongs[currentArtist.id] || [])
        .map(getSong)
        .filter(song => song && normalize(song.title).includes(query));

    if (matches.length === 0) {
        closeSuggestions();
        setStatus(`No songs matched "${originalQuery}" for ${currentArtist.name}.`);
        return;
    }

    renderSuggestions(matches.slice(0, getMaximumSuggestions()), matches.length);
}

function handleSearchKeydown(event) {
    if (event.key === "ArrowDown" && currentSuggestions.length > 0) {
        event.preventDefault();
        setActiveSuggestion(activeSuggestionIndex < 0 ? 0 : activeSuggestionIndex + 1);
    } else if (event.key === "ArrowUp" && currentSuggestions.length > 0) {
        event.preventDefault();
        setActiveSuggestion(
            activeSuggestionIndex < 0 ? currentSuggestions.length - 1 : activeSuggestionIndex - 1
        );
    } else if (event.key === "Enter" && currentSuggestions.length > 0) {
        event.preventDefault();
        chooseSuggestion(currentSuggestions[activeSuggestionIndex < 0 ? 0 : activeSuggestionIndex]);
    } else if (event.key === "Escape") {
        closeSuggestions();
    }
}

function restartChallenge() {
    if (typeof globalThis.location.reload === "function") {
        globalThis.location.reload();
    } else {
        globalThis.location.href = globalThis.location.href;
    }
}

function initialize() {
    if (!database?.artists || !database?.songs || !database?.artistSongs || !database?.songData) {
        searchInput.disabled = true;
        setStatus("The bundled song database could not be loaded.", true);
        return;
    }

    const parameters = new URLSearchParams(globalThis.location.search || "");
    startArtist = getArtist(parameters.get("start"));
    targetArtist = getArtist(parameters.get("end"));

    if (!startArtist || !targetArtist || startArtist.id === targetArtist.id) {
        searchInput.disabled = true;
        setStatus("This challenge is invalid. Return to the setup page and choose two artists.", true);
        return;
    }

    if (!findReachableArtists(startArtist.id).has(targetArtist.id)) {
        searchInput.disabled = true;
        setStatus("The selected target cannot be reached under the current game rules.", true);
        return;
    }

    startArtistElement.textContent = startArtist.name;
    targetArtistElement.textContent = targetArtist.name;
    document.title = `${startArtist.name} to ${targetArtist.name} - Songaveler`;

    route = [{ artistId: startArtist.id }];
    startedAt = Date.now();
    updateTimer();
    timerHandle = setInterval(updateTimer, 1000);
    timerHandle?.unref?.();
    selectArtist(startArtist);
}

const missingElements = [
    ["start-artist", startArtistElement],
    ["target-artist", targetArtistElement],
    ["artist", artistElement],
    ["search", searchInput],
    ["song-suggestions", suggestionsElement],
    ["choices", choicesElement],
    ["status", statusElement],
    ["move-count", moveCountElement],
    ["timer", timerElement],
    ["route-preview", routePreviewElement],
    ["restart-challenge", restartButton]
].filter(([, element]) => !element).map(([id]) => id);

if (missingElements.length > 0) {
    console.error(`The game page is missing: ${missingElements.join(", ")}.`);
} else {
    searchInput.addEventListener("input", updateSuggestions);
    searchInput.addEventListener("focus", updateSuggestions);
    searchInput.addEventListener("keydown", handleSearchKeydown);
    searchInput.addEventListener("blur", () => setTimeout(closeSuggestions, 150));
    restartButton.addEventListener("click", restartChallenge);
    initialize();
}

const database = globalThis.SONG_DATABASE;

const form = document.getElementById("challenge-form");
const startInput = document.getElementById("start-input");
const startSuggestions = document.getElementById("start-suggestions");
const endInput = document.getElementById("end-input");
const endSuggestions = document.getElementById("end-suggestions");
const startButton = document.getElementById("start-game");
const luckyButton = document.getElementById("lucky-button");
const shareButton = document.getElementById("share-link");
const statusElement = document.getElementById("setup-status");
const canonicalSiteUrl = "https://songaveler.romoboss.com/";

let selectedStartArtist = null;
let selectedEndArtist = null;
let reachableEndIds = null;
let startPicker = null;
let endPicker = null;
const reachabilityCache = new Map();
const distanceCache = new Map();

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

function getLuckyConnections() {
    const connections = Number(document.documentElement.dataset.luckyConnections);
    return Number.isInteger(connections) && connections >= 1
        ? connections
        : 2;
}

function getLuckyLinkedSongs() {
    const linkedSongs = Number(document.documentElement.dataset.luckyLinkedSongs);
    return Number.isInteger(linkedSongs) && linkedSongs >= 1
        ? linkedSongs
        : 25;
}

function getChallengeParameters() {
    return new URLSearchParams({
        start: selectedStartArtist.id,
        end: selectedEndArtist.id
    });
}

function getShareUrl() {
    const shareUrl = new URL("./game.html", canonicalSiteUrl);
    shareUrl.search = getChallengeParameters().toString();
    shareUrl.hash = "";
    return shareUrl.href;
}

async function copyText(text) {
    try {
        if (globalThis.navigator?.clipboard?.writeText) {
            await globalThis.navigator.clipboard.writeText(text);
            return;
        }
    } catch {
        // Fall through to the legacy copy method when Clipboard API access is denied.
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();

    try {
        if (!document.execCommand?.("copy")) throw new Error("Copy command failed");
    } finally {
        textarea.remove();
    }
}

async function shareChallenge() {
    if (!selectedStartArtist || !selectedEndArtist || selectedStartArtist.id === selectedEndArtist.id) {
        updateFormState();
        return;
    }

    const shareUrl = getShareUrl();
    shareButton.disabled = true;

    try {
        await copyText(shareUrl);
        setStatus("Challenge link copied to your clipboard.");
    } catch (error) {
        console.error("Could not copy challenge link:", error);
        setStatus(`Could not copy automatically. Copy this link: ${shareUrl}`, true);
    } finally {
        shareButton.disabled = false;
    }
}

function updateFormState() {
    const sameArtist = selectedStartArtist?.id === selectedEndArtist?.id;
    const ready = Boolean(selectedStartArtist && selectedEndArtist && !sameArtist);
    startButton.disabled = !ready;
    shareButton.disabled = !ready;

    if (selectedStartArtist && reachableEndIds?.size === 0) {
        setStatus("This artist has no reachable destination under the current game rules.", true);
    } else if (sameArtist) {
        setStatus("Choose two different artists.", true);
    } else if (ready) {
        setStatus(`${selectedStartArtist.name} to ${selectedEndArtist.name}. Ready to play.`);
    } else {
        setStatus("Select both artists from the suggestions.");
    }
}

function findReachableArtists(startId) {
    const cacheKey = String(startId);
    if (reachabilityCache.has(cacheKey)) return reachabilityCache.get(cacheKey);

    const reachable = new Set(findArtistDistances(cacheKey).keys());
    reachable.delete(cacheKey);
    reachabilityCache.set(cacheKey, reachable);
    return reachable;
}

function findArtistDistances(startId) {
    const cacheKey = String(startId);
    if (distanceCache.has(cacheKey)) return distanceCache.get(cacheKey);

    const distances = new Map([[cacheKey, 0]]);
    const queue = [cacheKey];

    while (queue.length > 0) {
        const artistId = queue.shift();
        const nextDistance = distances.get(artistId) + 1;
        for (const songId of database.artistSongs[artistId] || []) {
            for (const nextArtistId of database.songData[songId]?.artists || []) {
                const nextId = String(nextArtistId);
                if (distances.has(nextId)) continue;

                distances.set(nextId, nextDistance);
                if ((database.artistSongs[nextId] || []).length !== 1) {
                    queue.push(nextId);
                }
            }
        }
    }

    distanceCache.set(cacheKey, distances);
    return distances;
}

function getArtistRecord(id) {
    const name = database.artists[id];
    return name ? {
        id: String(id),
        name,
        normalizedName: normalize(name),
        songCount: (database.artistSongs[id] || []).length
    } : null;
}

function rankArtists(search, allowedIds = null) {
    return Object.entries(database.artists)
        .map(([id]) => getArtistRecord(id))
        .filter(artist =>
            artist
            && (!allowedIds || allowedIds.has(artist.id))
            && artist.normalizedName.includes(search)
        )
        .sort((left, right) => {
            const leftExact = left.normalizedName === search;
            const rightExact = right.normalizedName === search;
            if (leftExact !== rightExact) return leftExact ? -1 : 1;

            const leftPrefix = left.normalizedName.startsWith(search);
            const rightPrefix = right.normalizedName.startsWith(search);
            if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1;

            return left.name.localeCompare(right.name) || Number(left.id) - Number(right.id);
        })
        .slice(0, getMaximumSuggestions());
}

function createArtistPicker(input, suggestionList, onSelectionChange, getAllowedIds = () => null) {
    let selectedArtist = null;
    let visibleArtists = [];
    let activeIndex = -1;

    function close() {
        visibleArtists = [];
        activeIndex = -1;
        suggestionList.replaceChildren();
        suggestionList.hidden = true;
        input.setAttribute("aria-expanded", "false");
        input.removeAttribute("aria-activedescendant");
    }

    function choose(artist) {
        selectedArtist = artist;
        input.value = artist.name;
        input.dataset.artistId = artist.id;
        close();
        onSelectionChange(artist);
    }

    function setActive(index) {
        if (visibleArtists.length === 0) return;

        activeIndex = (index + visibleArtists.length) % visibleArtists.length;
        for (const [itemIndex, element] of [...suggestionList.children].entries()) {
            const active = itemIndex === activeIndex;
            element.classList.toggle("active", active);
            element.setAttribute("aria-selected", String(active));
        }
        input.setAttribute("aria-activedescendant", `${suggestionList.id}-option-${activeIndex}`);
    }

    function render(artists) {
        visibleArtists = artists;
        activeIndex = -1;
        suggestionList.replaceChildren();

        for (const [index, artist] of artists.entries()) {
            const button = document.createElement("button");
            const name = document.createElement("span");
            const detail = document.createElement("span");

            button.id = `${suggestionList.id}-option-${index}`;
            button.type = "button";
            button.classList.add("suggestion");
            button.dataset.artistId = artist.id;
            button.setAttribute("role", "option");
            button.setAttribute("aria-selected", "false");

            name.classList.add("suggestion-title");
            name.textContent = artist.name;
            detail.classList.add("suggestion-detail");
            detail.textContent = `${artist.songCount} linked song${artist.songCount === 1 ? "" : "s"}`;

            button.appendChild(name);
            button.appendChild(detail);
            button.addEventListener("mouseenter", () => setActive(index));
            button.addEventListener("mousedown", event => event.preventDefault());
            button.addEventListener("click", () => choose(artist));
            suggestionList.appendChild(button);
        }

        suggestionList.hidden = false;
        input.setAttribute("aria-expanded", "true");
    }

    function update() {
        if (selectedArtist && input.value !== selectedArtist.name) {
            selectedArtist = null;
            delete input.dataset.artistId;
            onSelectionChange(null);
        }

        const query = normalize(input.value);
        if (!query) {
            close();
            return;
        }

        const matches = rankArtists(query, getAllowedIds());
        if (matches.length === 0) {
            close();
            return;
        }

        render(matches);
    }

    input.addEventListener("input", update);
    input.addEventListener("focus", update);
    input.addEventListener("keydown", event => {
        if (event.key === "ArrowDown" && visibleArtists.length > 0) {
            event.preventDefault();
            setActive(activeIndex < 0 ? 0 : activeIndex + 1);
        } else if (event.key === "ArrowUp" && visibleArtists.length > 0) {
            event.preventDefault();
            setActive(activeIndex < 0 ? visibleArtists.length - 1 : activeIndex - 1);
        } else if (event.key === "Enter" && visibleArtists.length > 0) {
            event.preventDefault();
            choose(visibleArtists[activeIndex < 0 ? 0 : activeIndex]);
        } else if (event.key === "Escape") {
            close();
        }
    });
    input.addEventListener("blur", () => setTimeout(close, 150));

    return {
        select: choose,
        clear() {
            selectedArtist = null;
            input.value = "";
            delete input.dataset.artistId;
            close();
            onSelectionChange(null);
        }
    };
}

function chooseLuckyArtists() {
    const requiredLinkedSongs = getLuckyLinkedSongs();
    const candidates = Object.keys(database.artists)
        .filter(id => (database.artistSongs[id] || []).length >= requiredLinkedSongs);
    const shuffledStarts = [...candidates];
    for (let index = shuffledStarts.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [shuffledStarts[index], shuffledStarts[swapIndex]] = [
            shuffledStarts[swapIndex],
            shuffledStarts[index]
        ];
    }
    const requiredConnections = getLuckyConnections();

    for (const startId of shuffledStarts) {
        const distances = findArtistDistances(startId);
        const possibleEnds = candidates.filter(endId =>
            endId !== startId
            && distances.get(endId) === requiredConnections
        );

        if (possibleEnds.length === 0) continue;

        const endId = possibleEnds[Math.floor(Math.random() * possibleEnds.length)];
        startPicker.select(getArtistRecord(startId));
        endPicker.select(getArtistRecord(endId));
        setStatus(
            `${database.artists[startId]} to ${database.artists[endId]}. `
            + `${requiredConnections} connection${requiredConnections === 1 ? "" : "s"} apart and ready to play.`
        );
        return;
    }

    setStatus(
        `No eligible random challenge with ${requiredConnections} `
        + `connection${requiredConnections === 1 ? "" : "s"} and at least `
        + `${requiredLinkedSongs} linked song${requiredLinkedSongs === 1 ? "" : "s"} `
        + "per artist was found.",
        true
    );
}

function initialize() {
    if (!database?.artists || !database?.artistSongs) {
        startInput.disabled = true;
        endInput.disabled = true;
        setStatus("The bundled artist database could not be loaded.", true);
        return;
    }

    endInput.disabled = true;

    startPicker = createArtistPicker(startInput, startSuggestions, artist => {
        selectedStartArtist = artist;
        reachableEndIds = artist ? findReachableArtists(artist.id) : null;
        endInput.disabled = !artist || reachableEndIds.size === 0;

        if (selectedEndArtist && !reachableEndIds?.has(selectedEndArtist.id)) {
            endPicker.clear();
        }

        updateFormState();
    });
    endPicker = createArtistPicker(endInput, endSuggestions, artist => {
        selectedEndArtist = artist;
        updateFormState();
    }, () => reachableEndIds);

    form.addEventListener("submit", event => {
        event.preventDefault();
        if (!selectedStartArtist || !selectedEndArtist || selectedStartArtist.id === selectedEndArtist.id) {
            updateFormState();
            return;
        }

        globalThis.location.href = `./game.html?${getChallengeParameters()}`;
    });

    luckyButton.addEventListener("click", chooseLuckyArtists);
    shareButton.addEventListener("click", shareChallenge);

    updateFormState();
}

const missingElements = [
    ["challenge-form", form],
    ["start-input", startInput],
    ["start-suggestions", startSuggestions],
    ["end-input", endInput],
    ["end-suggestions", endSuggestions],
    ["start-game", startButton],
    ["lucky-button", luckyButton],
    ["share-link", shareButton],
    ["setup-status", statusElement]
].filter(([, element]) => !element).map(([id]) => id);

if (missingElements.length > 0) {
    console.error(`The setup page is missing: ${missingElements.join(", ")}.`);
} else {
    initialize();
}

const sourceDatabase = globalThis.SONG_ROUTE_DATABASE || globalThis.SONG_DATABASE;

const form = document.getElementById("challenge-form");
const startInput = document.getElementById("start-input");
const startSuggestions = document.getElementById("start-suggestions");
const endInput = document.getElementById("end-input");
const endSuggestions = document.getElementById("end-suggestions");
const startButton = document.getElementById("start-game");
const luckyButton = document.getElementById("lucky-button");
const swapButton = document.getElementById("swap-artists");
const shareButton = document.getElementById("share-link");
const statusElement = document.getElementById("setup-status");
const canonicalSiteUrl = "https://songaveler.romoboss.com/";

let selectedStartArtist = null;
let selectedEndArtist = null;
let reachableEndIds = null;
let startPicker = null;
let endPicker = null;
let routeDatabase = null;
let routeGraphPromise = null;

function normalize(value) {
    return String(value)
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase()
        .trim();
}

function buildAdjacency(database, artistIds) {
    const adjacency = [];

    for (const id of artistIds) {
        const neighbors = new Set();
        for (const songId of database.artistSongs[id] || []) {
            for (const nextArtistId of database.songData?.[songId]?.artists || []) {
                const nextId = String(nextArtistId);
                if (nextId !== id) neighbors.add(nextId);
            }
        }
        adjacency[Number(id)] = [...neighbors];
    }

    return adjacency;
}

function buildComponentMetadata(records, adjacency) {
    const recordsById = new Map(records.map(record => [record.id, record]));
    const componentSizes = [];
    let nextComponentId = 0;

    for (const record of records) {
        if (record.songCount === 1 || record.componentId !== null) continue;

        const componentId = nextComponentId;
        nextComponentId += 1;
        const queue = [record.id];
        record.componentId = componentId;

        for (let cursor = 0; cursor < queue.length; cursor += 1) {
            const artistId = queue[cursor];
            for (const nextIdValue of adjacency[Number(artistId)] || []) {
                const nextRecord = recordsById.get(String(nextIdValue));
                if (!nextRecord || nextRecord.songCount === 1 || nextRecord.componentId !== null) {
                    continue;
                }
                nextRecord.componentId = componentId;
                queue.push(nextRecord.id);
            }
        }
    }

    for (const record of records) {
        if (record.songCount !== 1) continue;
        for (const nextIdValue of adjacency[Number(record.id)] || []) {
            const componentId = recordsById.get(String(nextIdValue))?.componentId;
            if (componentId !== null && componentId !== undefined) {
                record.componentId = componentId;
                break;
            }
        }
    }

    for (const record of records) {
        if (record.componentId === null) continue;
        componentSizes[record.componentId] = (componentSizes[record.componentId] || 0) + 1;
    }

    return componentSizes;
}

function prepareRouteDatabase(database) {
    if (Array.isArray(database?.records)) {
        const records = database.records.map(row => ({
            id: String(row[0]),
            name: row[1],
            normalizedName: normalize(row[1]),
            songCount: row[2],
            componentId: row[3] ?? null
        }));
        records.sort((left, right) =>
            left.name.localeCompare(right.name) || Number(left.id) - Number(right.id)
        );
        return {
            records,
            recordsById: new Map(records.map(record => [record.id, record])),
            adjacency: Array.isArray(globalThis.SONG_ROUTE_GRAPH?.adjacency)
                ? globalThis.SONG_ROUTE_GRAPH.adjacency
                : null,
            terminalAdjacency: database.terminalAdjacency || [],
            componentSizes: database.componentSizes || []
        };
    }

    const artistIds = Object.keys(database?.artists || {});
    const records = artistIds.map(id => ({
        id,
        name: database.artists[id],
        normalizedName: normalize(database.artists[id]),
        songCount: (database.artistSongs[id] || []).length,
        componentId: null
    }));
    const adjacency = buildAdjacency(database, artistIds);
    const componentSizes = buildComponentMetadata(records, adjacency);
    records.sort((left, right) =>
        left.name.localeCompare(right.name) || Number(left.id) - Number(right.id)
    );

    return {
        records,
        recordsById: new Map(records.map(record => [record.id, record])),
        adjacency,
        terminalAdjacency: [],
        componentSizes
    };
}

function getArtistNeighbors(artistId) {
    const index = Number(artistId);
    return routeDatabase.adjacency?.[index]
        || routeDatabase.terminalAdjacency[index]
        || [];
}

function getRouteGraphUrl() {
    const version = encodeURIComponent(sourceDatabase.graphVersion || "1");
    return `./data/route-graph.js?v=${version}`;
}

function useLoadedRouteGraph() {
    const graph = globalThis.SONG_ROUTE_GRAPH;
    if (!Array.isArray(graph?.adjacency)) return false;
    if (
        sourceDatabase.graphVersion
        && graph.version
        && graph.version !== sourceDatabase.graphVersion
    ) {
        return false;
    }
    routeDatabase.adjacency = graph.adjacency;
    return true;
}

function loadRouteGraph() {
    if (routeDatabase.adjacency || useLoadedRouteGraph()) return Promise.resolve();
    if (routeGraphPromise) return routeGraphPromise;
    if (!document.head?.appendChild) {
        return Promise.reject(new Error("The route graph could not be loaded on this page."));
    }

    routeGraphPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = getRouteGraphUrl();
        script.async = true;
        script.addEventListener("load", () => {
            if (useLoadedRouteGraph()) resolve();
            else reject(new Error("The downloaded route graph is invalid."));
        });
        script.addEventListener("error", () => {
            reject(new Error("The route graph download failed."));
        });
        document.head.appendChild(script);
    }).catch(error => {
        routeGraphPromise = null;
        throw error;
    });

    return routeGraphPromise;
}

function prefetchRouteGraph() {
    if (routeDatabase.adjacency || !document.head?.appendChild) return;
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.as = "script";
    link.href = getRouteGraphUrl();
    document.head.appendChild(link);
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
    const shareUrl = new URL("./game", canonicalSiteUrl);
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
    swapButton.disabled = !ready;
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
    const startRecord = routeDatabase.recordsById.get(cacheKey);
    if (!startRecord) return new Set();

    if (startRecord.componentId !== null) {
        const componentId = startRecord.componentId;
        return {
            size: Math.max(0, (routeDatabase.componentSizes[componentId] || 0) - 1),
            has(id) {
                const candidate = routeDatabase.recordsById.get(String(id));
                return candidate?.id !== cacheKey && candidate?.componentId === componentId;
            }
        };
    }

    const reachable = new Set(
        getArtistNeighbors(cacheKey).map(String)
    );
    reachable.delete(cacheKey);
    return reachable;
}

function findArtistDistances(startId, maximumDistance = Infinity) {
    const cacheKey = String(startId);
    const distances = new Map([[cacheKey, 0]]);
    const queue = [cacheKey];

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const artistId = queue[cursor];
        const nextDistance = distances.get(artistId) + 1;
        if (nextDistance > maximumDistance) continue;

        for (const nextArtistId of getArtistNeighbors(artistId)) {
            const nextId = String(nextArtistId);
            if (distances.has(nextId)) continue;

            distances.set(nextId, nextDistance);
            if (
                nextDistance < maximumDistance
                && routeDatabase.recordsById.get(nextId)?.songCount !== 1
            ) {
                queue.push(nextId);
            }
        }
    }

    return distances;
}

function getArtistRecord(id) {
    return routeDatabase.recordsById.get(String(id)) || null;
}

function rankArtists(search, allowedIds = null) {
    const maximumSuggestions = getMaximumSuggestions();
    const exactMatches = [];
    const prefixMatches = [];
    const otherMatches = [];

    for (const artist of routeDatabase.records) {
        if (allowedIds && !allowedIds.has(artist.id)) continue;
        if (!artist.normalizedName.includes(search)) continue;

        const bucket = artist.normalizedName === search
            ? exactMatches
            : artist.normalizedName.startsWith(search)
                ? prefixMatches
                : otherMatches;
        if (bucket.length < maximumSuggestions) bucket.push(artist);
    }

    return [...exactMatches, ...prefixMatches, ...otherMatches].slice(0, maximumSuggestions);
}

function createArtistPicker(input, suggestionList, onSelectionChange, getAllowedIds = () => null) {
    let selectedArtist = null;
    let visibleArtists = [];
    let activeIndex = -1;
    let scheduledFrame = null;
    let renderedArtistIds = "";

    function cancelScheduledUpdate() {
        if (scheduledFrame === null) return;
        globalThis.cancelAnimationFrame?.(scheduledFrame);
        scheduledFrame = null;
    }

    function close() {
        cancelScheduledUpdate();
        visibleArtists = [];
        activeIndex = -1;
        renderedArtistIds = "";
        if (suggestionList.children.length > 0) suggestionList.replaceChildren();
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
        const nextArtistIds = artists.map(artist => artist.id).join(",");

        if (nextArtistIds === renderedArtistIds) {
            for (const element of suggestionList.children) {
                element.classList.toggle("active", false);
                element.setAttribute("aria-selected", "false");
            }
            suggestionList.hidden = false;
            input.setAttribute("aria-expanded", "true");
            input.removeAttribute("aria-activedescendant");
            return;
        }

        renderedArtistIds = nextArtistIds;
        const elements = [];
        const fragment = document.createDocumentFragment?.();

        for (const [index, artist] of artists.entries()) {
            const button = document.createElement("button");
            const name = document.createElement("span");
            const detail = document.createElement("span");

            button.id = `${suggestionList.id}-option-${index}`;
            button.type = "button";
            button.classList.add("suggestion");
            button.dataset.artistId = artist.id;
            button.dataset.suggestionIndex = String(index);
            button.setAttribute("role", "option");
            button.setAttribute("aria-selected", "false");

            name.classList.add("suggestion-title");
            name.textContent = artist.name;
            detail.classList.add("suggestion-detail");
            detail.textContent = `${artist.songCount} linked song${artist.songCount === 1 ? "" : "s"}`;

            button.appendChild(name);
            button.appendChild(detail);
            elements.push(button);
            fragment?.appendChild(button);
        }

        if (fragment) suggestionList.replaceChildren(fragment);
        else suggestionList.replaceChildren(...elements);

        suggestionList.hidden = false;
        input.setAttribute("aria-expanded", "true");
    }

    function update() {
        invalidateEditedSelection();

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

    function invalidateEditedSelection() {
        if (!selectedArtist || input.value === selectedArtist.name) return;
        selectedArtist = null;
        delete input.dataset.artistId;
        onSelectionChange(null);
    }

    function scheduleUpdate() {
        if (typeof globalThis.requestAnimationFrame !== "function") {
            update();
            return;
        }
        if (scheduledFrame !== null) return;
        scheduledFrame = globalThis.requestAnimationFrame(() => {
            scheduledFrame = null;
            update();
        });
    }

    function flushScheduledUpdate() {
        if (scheduledFrame === null) return;
        cancelScheduledUpdate();
        update();
    }

    function getSuggestionFromEvent(event) {
        let element = event.target;
        while (element && element !== suggestionList) {
            if (element.classList?.contains("suggestion")) return element;
            element = element.parentNode;
        }
        return null;
    }

    suggestionList.addEventListener("mouseover", event => {
        const suggestion = getSuggestionFromEvent(event);
        if (suggestion) setActive(Number(suggestion.dataset.suggestionIndex));
    });
    suggestionList.addEventListener("mousedown", event => {
        if (getSuggestionFromEvent(event)) event.preventDefault();
    });
    suggestionList.addEventListener("click", event => {
        const suggestion = getSuggestionFromEvent(event);
        const artist = suggestion && visibleArtists[Number(suggestion.dataset.suggestionIndex)];
        if (artist) choose(artist);
    });

    input.addEventListener("input", () => {
        invalidateEditedSelection();
        scheduleUpdate();
    });
    input.addEventListener("focus", () => {
        if (selectedArtist && input.value === selectedArtist.name) {
            close();
            return;
        }
        scheduleUpdate();
    });
    input.addEventListener("keydown", event => {
        flushScheduledUpdate();
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

function generateLuckyChallenge() {
    const requiredLinkedSongs = getLuckyLinkedSongs();
    const candidates = routeDatabase.records
        .filter(artist => artist.songCount >= requiredLinkedSongs)
        .map(artist => artist.id)
        .sort((left, right) => Number(left) - Number(right));
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
        const distances = findArtistDistances(startId, requiredConnections);
        const possibleEnds = candidates.filter(endId =>
            endId !== startId
            && distances.get(endId) === requiredConnections
        );

        if (possibleEnds.length === 0) continue;

        const endId = possibleEnds[Math.floor(Math.random() * possibleEnds.length)];
        startPicker.select(getArtistRecord(startId));
        endPicker.select(getArtistRecord(endId));
        setStatus(
            `${getArtistRecord(startId).name} to ${getArtistRecord(endId).name}. `
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

function chooseLuckyArtists() {
    if (routeDatabase.adjacency) {
        generateLuckyChallenge();
        return;
    }

    luckyButton.disabled = true;
    setStatus("Preparing a random challenge…");
    return loadRouteGraph()
        .then(generateLuckyChallenge)
        .catch(error => {
            console.error("Could not load the route graph:", error);
            setStatus("The random challenge data could not be loaded. Please try again.", true);
        })
        .finally(() => {
            luckyButton.disabled = false;
        });
}

function swapSelectedArtists() {
    if (!selectedStartArtist || !selectedEndArtist || selectedStartArtist.id === selectedEndArtist.id) {
        updateFormState();
        return;
    }

    const previousStartArtist = selectedStartArtist;
    const previousEndArtist = selectedEndArtist;
    startPicker.select(previousEndArtist);
    endPicker.select(previousStartArtist);
}

function initialize() {
    const isRouteDatabase = Array.isArray(sourceDatabase?.records)
        && Array.isArray(sourceDatabase?.componentSizes);
    const isFullDatabase = sourceDatabase?.artists && sourceDatabase?.artistSongs
        && sourceDatabase?.songData;
    if (!isRouteDatabase && !isFullDatabase) {
        startInput.disabled = true;
        endInput.disabled = true;
        setStatus("The bundled artist database could not be loaded.", true);
        return;
    }

    routeDatabase = prepareRouteDatabase(sourceDatabase);
    if (isRouteDatabase) prefetchRouteGraph();

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

        globalThis.location.href = `./game?${getChallengeParameters()}`;
    });

    luckyButton.addEventListener("click", chooseLuckyArtists);
    swapButton.addEventListener("click", swapSelectedArtists);
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
    ["swap-artists", swapButton],
    ["share-link", shareButton],
    ["setup-status", statusElement]
].filter(([, element]) => !element).map(([id]) => id);

if (missingElements.length > 0) {
    console.error(`The setup page is missing: ${missingElements.join(", ")}.`);
} else {
    initialize();
}

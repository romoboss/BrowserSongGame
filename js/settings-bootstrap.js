(() => {
    "use strict";

    const storageKeys = {
        theme: "music-link-theme",
        resultLimit: "music-link-result-limit",
        uiTransparency: "music-link-ui-transparency",
        luckyConnections: "music-link-lucky-connections",
        luckyLinkedSongs: "music-link-lucky-linked-songs"
    };
    const validThemes = new Set([
        "white", "grey", "black", "oled-black",
        "blue", "purple", "red", "green", "yellow", "cyan", "pink",
        "dark-blue", "dark-purple", "dark-red", "dark-green", "dark-yellow",
        "dark-cyan", "dark-pink"
    ]);

    function normalizeTheme(value) {
        if (value === "midnight" || value === "deep-space") return "oled-black";
        return validThemes.has(value) ? value : null;
    }

    function parseInteger(value, minimum, maximum) {
        if (value === null || value === undefined || value === "") return null;
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
            ? parsed
            : null;
    }

    function readStored(key) {
        try {
            return globalThis.localStorage?.getItem(key) ?? null;
        } catch {
            return null;
        }
    }

    function store(key, value) {
        try {
            globalThis.localStorage?.setItem(key, String(value));
        } catch {
            // The in-page value still applies when browser storage is unavailable.
        }
    }

    let parameters;
    try {
        parameters = new URLSearchParams(globalThis.location?.search || "");
    } catch {
        parameters = new URLSearchParams();
    }

    const locationTheme = normalizeTheme(parameters.get("theme"));
    const locationResultLimit = parseInteger(parameters.get("limit"), 1, 25);
    const locationUiTransparency = parseInteger(parameters.get("transparency"), 0, 80);
    const theme = locationTheme || normalizeTheme(readStored(storageKeys.theme)) || "white";
    const resultLimit = locationResultLimit
        ?? parseInteger(readStored(storageKeys.resultLimit), 1, 25)
        ?? 10;
    const uiTransparency = locationUiTransparency
        ?? parseInteger(readStored(storageKeys.uiTransparency), 0, 80)
        ?? 48;
    const luckyConnections = parseInteger(readStored(storageKeys.luckyConnections), 1, 5) ?? 2;
    const luckyLinkedSongs = parseInteger(readStored(storageKeys.luckyLinkedSongs), 5, 75) ?? 25;

    if (locationTheme) store(storageKeys.theme, locationTheme);
    if (locationResultLimit !== null) store(storageKeys.resultLimit, locationResultLimit);
    if (locationUiTransparency !== null) {
        store(storageKeys.uiTransparency, locationUiTransparency);
    }

    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.resultLimit = String(resultLimit);
    root.dataset.uiTransparency = String(uiTransparency);
    root.dataset.luckyConnections = String(luckyConnections);
    root.dataset.luckyLinkedSongs = String(luckyLinkedSongs);
    root.style?.setProperty?.("--ui-panel-opacity", `${100 - uiTransparency}%`);

    const legacyKeys = ["theme", "limit", "transparency"];
    const hadLegacySettings = legacyKeys.some(key => parameters.has(key));
    for (const key of legacyKeys) parameters.delete(key);
    const pathname = globalThis.location?.pathname;
    if (hadLegacySettings && pathname && typeof globalThis.history?.replaceState === "function") {
        const query = parameters.toString();
        const hash = globalThis.location?.hash || "";
        globalThis.history.replaceState(
            globalThis.history.state,
            "",
            `${pathname}${query ? `?${query}` : ""}${hash}`
        );
    }

    globalThis.SongavelerSettingsBootstrap = Object.freeze({
        theme,
        resultLimit,
        uiTransparency,
        luckyConnections,
        luckyLinkedSongs
    });
})();

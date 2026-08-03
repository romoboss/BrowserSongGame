(() => {
    const themeStorageKey = "music-link-theme";
    const resultLimitStorageKey = "music-link-result-limit";
    const uiTransparencyStorageKey = "music-link-ui-transparency";
    const luckyConnectionsStorageKey = "music-link-lucky-connections";
    const luckyLinkedSongsStorageKey = "music-link-lucky-linked-songs";
    const defaultResultLimit = 10;
    const minimumResultLimit = 1;
    const maximumResultLimit = 25;
    const defaultUiTransparency = 48;
    const minimumUiTransparency = 0;
    const maximumUiTransparency = 80;
    const defaultLuckyConnections = 2;
    const minimumLuckyConnections = 1;
    const maximumLuckyConnections = 5;
    const defaultLuckyLinkedSongs = 25;
    const minimumLuckyLinkedSongs = 5;
    const maximumLuckyLinkedSongs = 75;
    const themeGroups = [
        {
            label: "Neutral",
            themes: [
                { id: "white", label: "White" },
                { id: "grey", label: "Light Grey" },
                { id: "black", label: "Dark Grey" },
                { id: "oled-black", label: "Black" }
            ]
        },
        {
            label: "Light colors",
            themes: [
                { id: "blue", label: "Blue" },
                { id: "purple", label: "Purple" },
                { id: "red", label: "Red" },
                { id: "green", label: "Green" },
                { id: "yellow", label: "Yellow" },
                { id: "cyan", label: "Cyan" },
                { id: "pink", label: "Pink" }
            ]
        },
        {
            label: "Dark colors",
            themes: [
                { id: "dark-blue", label: "Dark Blue" },
                { id: "dark-purple", label: "Dark Purple" },
                { id: "dark-red", label: "Dark Red" },
                { id: "dark-green", label: "Dark Green" },
                { id: "dark-yellow", label: "Dark Yellow" },
                { id: "dark-cyan", label: "Dark Cyan" },
                { id: "dark-pink", label: "Dark Pink" }
            ]
        }
    ];
    const themes = themeGroups.flatMap(group => group.themes);
    const validThemes = new Set(themes.map(theme => theme.id));

    function normalizeTheme(theme) {
        if (theme === "midnight" || theme === "deep-space") return "oled-black";
        return validThemes.has(theme) ? theme : null;
    }

    function parseResultLimit(value) {
        const resultLimit = Number(value);
        return Number.isInteger(resultLimit)
            && resultLimit >= minimumResultLimit
            && resultLimit <= maximumResultLimit
            ? resultLimit
            : null;
    }

    function parseUiTransparency(value) {
        if (value === null || value === undefined || value === "") return null;
        const transparency = Number(value);
        return Number.isInteger(transparency)
            && transparency >= minimumUiTransparency
            && transparency <= maximumUiTransparency
            ? transparency
            : null;
    }

    function parseLuckyConnections(value) {
        const connections = Number(value);
        return Number.isInteger(connections)
            && connections >= minimumLuckyConnections
            && connections <= maximumLuckyConnections
            ? connections
            : null;
    }

    function parseLuckyLinkedSongs(value) {
        const linkedSongs = Number(value);
        return Number.isInteger(linkedSongs)
            && linkedSongs >= minimumLuckyLinkedSongs
            && linkedSongs <= maximumLuckyLinkedSongs
            ? linkedSongs
            : null;
    }

    function readLocationTheme() {
        try {
            const theme = new URLSearchParams(globalThis.location?.search || "").get("theme");
            return normalizeTheme(theme);
        } catch {
            return null;
        }
    }

    function readStoredTheme() {
        try {
            const storedTheme = globalThis.localStorage?.getItem(themeStorageKey);
            return normalizeTheme(storedTheme) || "white";
        } catch {
            return "white";
        }
    }

    function readLocationResultLimit() {
        try {
            return parseResultLimit(
                new URLSearchParams(globalThis.location?.search || "").get("limit")
            );
        } catch {
            return null;
        }
    }

    function readStoredResultLimit() {
        try {
            return parseResultLimit(globalThis.localStorage?.getItem(resultLimitStorageKey))
                ?? defaultResultLimit;
        } catch {
            return defaultResultLimit;
        }
    }

    function readLocationUiTransparency() {
        try {
            return parseUiTransparency(
                new URLSearchParams(globalThis.location?.search || "").get("transparency")
            );
        } catch {
            return null;
        }
    }

    function readStoredUiTransparency() {
        try {
            return parseUiTransparency(globalThis.localStorage?.getItem(uiTransparencyStorageKey))
                ?? defaultUiTransparency;
        } catch {
            return defaultUiTransparency;
        }
    }

    function readStoredLuckyConnections() {
        try {
            return parseLuckyConnections(
                globalThis.localStorage?.getItem(luckyConnectionsStorageKey)
            ) ?? defaultLuckyConnections;
        } catch {
            return defaultLuckyConnections;
        }
    }

    function readStoredLuckyLinkedSongs() {
        try {
            return parseLuckyLinkedSongs(
                globalThis.localStorage?.getItem(luckyLinkedSongsStorageKey)
            ) ?? defaultLuckyLinkedSongs;
        } catch {
            return defaultLuckyLinkedSongs;
        }
    }

    function storeTheme(theme) {
        try {
            globalThis.localStorage?.setItem(themeStorageKey, theme);
        } catch {
            // Theme changes still work for this page when file storage is unavailable.
        }
    }

    function storeResultLimit(resultLimit) {
        try {
            globalThis.localStorage?.setItem(resultLimitStorageKey, String(resultLimit));
        } catch {
            // The selected limit still works for this page when file storage is unavailable.
        }
    }

    function storeUiTransparency(transparency) {
        try {
            globalThis.localStorage?.setItem(uiTransparencyStorageKey, String(transparency));
        } catch {
            // Transparency changes still work for this page when file storage is unavailable.
        }
    }

    function storeLuckyConnections(connections) {
        try {
            globalThis.localStorage?.setItem(luckyConnectionsStorageKey, String(connections));
        } catch {
            // Lucky selections still use the value for this page when storage is unavailable.
        }
    }

    function storeLuckyLinkedSongs(linkedSongs) {
        try {
            globalThis.localStorage?.setItem(luckyLinkedSongsStorageKey, String(linkedSongs));
        } catch {
            // Lucky selections still use the value for this page when storage is unavailable.
        }
    }

    function removeLegacySettingsFromUrl() {
        try {
            const parameters = new URLSearchParams(globalThis.location?.search || "");
            const legacyParameters = ["theme", "limit", "transparency"];
            const removed = legacyParameters.some(parameter => parameters.has(parameter));
            for (const parameter of legacyParameters) parameters.delete(parameter);
            const pathname = globalThis.location?.pathname;
            if (!removed || !pathname || typeof globalThis.history?.replaceState !== "function") {
                return;
            }

            const query = parameters.toString();
            const hash = globalThis.location?.hash || "";
            globalThis.history.replaceState(
                globalThis.history.state,
                "",
                `${pathname}${query ? `?${query}` : ""}${hash}`
            );
        } catch {
            // Old links still work if browser history cannot be rewritten.
        }
    }

    function setPanelOpacity(transparency) {
        document.documentElement.dataset.uiTransparency = String(transparency);
        const style = document.documentElement.style;
        const opacity = `${100 - transparency}%`;
        if (typeof style?.setProperty === "function") {
            style.setProperty("--ui-panel-opacity", opacity);
        } else if (style) {
            style["--ui-panel-opacity"] = opacity;
        }
    }

    const locationTheme = readLocationTheme();
    const locationResultLimit = readLocationResultLimit();
    const locationUiTransparency = readLocationUiTransparency();
    let selectedTheme = locationTheme || readStoredTheme();
    let selectedResultLimit = locationResultLimit ?? readStoredResultLimit();
    let selectedUiTransparency = locationUiTransparency ?? readStoredUiTransparency();
    let selectedLuckyConnections = readStoredLuckyConnections();
    let selectedLuckyLinkedSongs = readStoredLuckyLinkedSongs();

    if (locationTheme) storeTheme(locationTheme);
    if (locationResultLimit !== null) storeResultLimit(locationResultLimit);
    if (locationUiTransparency !== null) storeUiTransparency(locationUiTransparency);
    removeLegacySettingsFromUrl();

    document.documentElement.dataset.theme = selectedTheme;
    document.documentElement.dataset.resultLimit = String(selectedResultLimit);
    document.documentElement.dataset.luckyConnections = String(selectedLuckyConnections);
    document.documentElement.dataset.luckyLinkedSongs = String(selectedLuckyLinkedSongs);
    setPanelOpacity(selectedUiTransparency);

    function initializeSettings() {
        if (!document.body || document.getElementById("settings-button")) return;

        const launcherContainer = document.createElement("div");
        const launcher = document.createElement("button");
        const launcherIcon = document.createElement("span");
        const scrim = document.createElement("div");
        const panel = document.createElement("div");
        const header = document.createElement("div");
        const title = document.createElement("h2");
        const closeButton = document.createElement("button");
        const closeIcon = document.createElement("span");
        const appearanceSection = document.createElement("div");
        const appearanceTitle = document.createElement("h3");
        const appearanceDescription = document.createElement("p");
        const themeControl = document.createElement("div");
        const themeSelectLabel = document.createElement("label");
        const themeSelectWrapper = document.createElement("div");
        const themeSwatch = document.createElement("span");
        const themeSelect = document.createElement("select");
        const transparencySection = document.createElement("div");
        const transparencyTitle = document.createElement("h3");
        const transparencyDescription = document.createElement("p");
        const transparencyHeader = document.createElement("div");
        const transparencyLabel = document.createElement("label");
        const transparencyValue = document.createElement("output");
        const transparencySlider = document.createElement("input");
        const transparencyBounds = document.createElement("div");
        const transparencyMinimum = document.createElement("span");
        const transparencyMaximum = document.createElement("span");
        const resultSection = document.createElement("div");
        const resultTitle = document.createElement("h3");
        const resultDescription = document.createElement("p");
        const resultHeader = document.createElement("div");
        const resultLabel = document.createElement("label");
        const resultValue = document.createElement("output");
        const resultSlider = document.createElement("input");
        const resultBounds = document.createElement("div");
        const resultMinimum = document.createElement("span");
        const resultMaximum = document.createElement("span");
        const luckySection = document.createElement("div");
        const luckyTitle = document.createElement("h3");
        const luckyDescription = document.createElement("p");
        const luckyHeader = document.createElement("div");
        const luckyLabel = document.createElement("label");
        const luckyValue = document.createElement("output");
        const luckySlider = document.createElement("input");
        const luckyBounds = document.createElement("div");
        const luckyMinimum = document.createElement("span");
        const luckyMaximum = document.createElement("span");
        const linkedSongsHeader = document.createElement("div");
        const linkedSongsLabel = document.createElement("label");
        const linkedSongsValue = document.createElement("output");
        const linkedSongsSlider = document.createElement("input");
        const linkedSongsBounds = document.createElement("div");
        const linkedSongsMinimum = document.createElement("span");
        const linkedSongsMaximum = document.createElement("span");
        const contactSection = document.createElement("div");
        const contactTitle = document.createElement("h3");
        const contactDescription = document.createElement("p");
        const pageContent = typeof document.querySelector === "function"
            ? document.querySelector("main")
            : null;
        let previousBodyOverflow = "";

        launcherContainer.className = "settings-launcher-container";
        launcher.id = "settings-button";
        launcher.type = "button";
        launcher.className = "settings-button";
        launcher.setAttribute("aria-controls", "settings-panel");
        launcher.setAttribute("aria-expanded", "false");
        launcherIcon.className = "settings-button-icon";
        launcherIcon.textContent = "⚙";
        launcherIcon.setAttribute("aria-hidden", "true");
        launcher.appendChild(launcherIcon);
        const launcherLabel = document.createElement("span");
        launcherLabel.textContent = "Settings";
        launcher.appendChild(launcherLabel);
        launcherContainer.appendChild(launcher);

        scrim.className = "settings-scrim";
        scrim.hidden = true;
        scrim.setAttribute("aria-hidden", "true");

        panel.id = "settings-panel";
        panel.className = "settings-panel";
        panel.hidden = true;
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        panel.setAttribute("aria-labelledby", "settings-title");

        header.className = "settings-panel-header";
        title.id = "settings-title";
        title.className = "settings-panel-title";
        title.textContent = "Settings";
        closeButton.type = "button";
        closeButton.className = "settings-close-button";
        closeButton.setAttribute("aria-label", "Close settings");
        closeIcon.className = "settings-close-icon";
        closeIcon.setAttribute("aria-hidden", "true");
        closeButton.appendChild(closeIcon);
        header.appendChild(title);
        header.appendChild(closeButton);

        appearanceSection.className = "settings-section";
        appearanceTitle.className = "settings-section-title";
        appearanceTitle.textContent = "Appearance";
        appearanceDescription.className = "settings-section-description";
        appearanceDescription.textContent = "Choose a color theme for every page.";
        themeControl.className = "theme-select-control";
        themeSelectLabel.className = "settings-control-label";
        themeSelectLabel.htmlFor = "theme-select";
        themeSelectLabel.textContent = "Color theme";
        themeSelectWrapper.className = "theme-select-wrapper";
        themeSwatch.className = `theme-swatch theme-swatch-${selectedTheme}`;
        themeSwatch.setAttribute("aria-hidden", "true");
        themeSelect.id = "theme-select";
        themeSelect.className = "theme-select";
        themeSelect.setAttribute("aria-label", "Color theme");

        function applyTheme(theme, persist = true) {
            selectedTheme = normalizeTheme(theme) || "white";
            document.documentElement.dataset.theme = selectedTheme;
            themeSelect.value = selectedTheme;
            themeSwatch.className = `theme-swatch theme-swatch-${selectedTheme}`;
            if (persist) storeTheme(selectedTheme);
        }

        function applyResultLimit(resultLimit, persist = true) {
            selectedResultLimit = parseResultLimit(resultLimit) ?? defaultResultLimit;
            document.documentElement.dataset.resultLimit = String(selectedResultLimit);
            resultSlider.value = String(selectedResultLimit);
            resultValue.textContent = String(selectedResultLimit);
            if (persist) storeResultLimit(selectedResultLimit);
        }

        function applyUiTransparency(transparency, persist = true) {
            selectedUiTransparency = parseUiTransparency(transparency)
                ?? defaultUiTransparency;
            setPanelOpacity(selectedUiTransparency);
            transparencySlider.value = String(selectedUiTransparency);
            transparencyValue.textContent = `${selectedUiTransparency}%`;
            transparencySlider.setAttribute(
                "aria-valuetext",
                `${selectedUiTransparency}% transparent`
            );
            if (persist) storeUiTransparency(selectedUiTransparency);
        }

        function applyLuckyConnections(connections, persist = true) {
            selectedLuckyConnections = parseLuckyConnections(connections)
                ?? defaultLuckyConnections;
            const label = `${selectedLuckyConnections} connection${selectedLuckyConnections === 1 ? "" : "s"}`;
            document.documentElement.dataset.luckyConnections = String(selectedLuckyConnections);
            luckySlider.value = String(selectedLuckyConnections);
            luckyValue.textContent = String(selectedLuckyConnections);
            luckySlider.setAttribute("aria-valuetext", label);
            if (persist) storeLuckyConnections(selectedLuckyConnections);
        }

        function applyLuckyLinkedSongs(linkedSongs, persist = true) {
            selectedLuckyLinkedSongs = parseLuckyLinkedSongs(linkedSongs)
                ?? defaultLuckyLinkedSongs;
            const label = `${selectedLuckyLinkedSongs} linked song${selectedLuckyLinkedSongs === 1 ? "" : "s"}`;
            document.documentElement.dataset.luckyLinkedSongs = String(selectedLuckyLinkedSongs);
            linkedSongsSlider.value = String(selectedLuckyLinkedSongs);
            linkedSongsValue.textContent = String(selectedLuckyLinkedSongs);
            linkedSongsSlider.setAttribute("aria-valuetext", label);
            if (persist) storeLuckyLinkedSongs(selectedLuckyLinkedSongs);
        }

        for (const group of themeGroups) {
            const optionGroup = document.createElement("optgroup");
            optionGroup.label = group.label;
            for (const theme of group.themes) {
                const option = document.createElement("option");
                option.value = theme.id;
                option.textContent = theme.label;
                optionGroup.appendChild(option);
            }
            themeSelect.appendChild(optionGroup);
        }
        themeSelect.addEventListener("change", () => applyTheme(themeSelect.value));
        themeSelectWrapper.appendChild(themeSwatch);
        themeSelectWrapper.appendChild(themeSelect);
        themeControl.appendChild(themeSelectLabel);
        themeControl.appendChild(themeSelectWrapper);

        appearanceSection.appendChild(appearanceTitle);
        appearanceSection.appendChild(appearanceDescription);
        appearanceSection.appendChild(themeControl);

        transparencySection.className = "settings-section";
        transparencyTitle.className = "settings-section-title";
        transparencyTitle.textContent = "UI transparency";
        transparencyDescription.className = "settings-section-description";
        transparencyDescription.textContent = "Adjust how much of the background shows through framed panels.";
        transparencyHeader.className = "settings-range-header";
        transparencyLabel.className = "settings-range-label";
        transparencyLabel.textContent = "Transparency";
        transparencyLabel.htmlFor = "ui-transparency";
        transparencyValue.className = "settings-range-value";
        transparencyValue.textContent = `${selectedUiTransparency}%`;
        transparencyValue.setAttribute("for", "ui-transparency");
        transparencyHeader.appendChild(transparencyLabel);
        transparencyHeader.appendChild(transparencyValue);
        transparencySlider.id = "ui-transparency";
        transparencySlider.className = "settings-range";
        transparencySlider.type = "range";
        transparencySlider.min = String(minimumUiTransparency);
        transparencySlider.max = String(maximumUiTransparency);
        transparencySlider.step = "1";
        transparencySlider.value = String(selectedUiTransparency);
        transparencySlider.setAttribute("aria-valuemin", String(minimumUiTransparency));
        transparencySlider.setAttribute("aria-valuemax", String(maximumUiTransparency));
        transparencySlider.setAttribute(
            "aria-valuetext",
            `${selectedUiTransparency}% transparent`
        );
        transparencySlider.addEventListener(
            "input",
            () => applyUiTransparency(transparencySlider.value)
        );
        transparencyBounds.className = "settings-range-bounds";
        transparencyBounds.setAttribute("aria-hidden", "true");
        transparencyMinimum.textContent = "Opaque";
        transparencyMaximum.textContent = "Most transparent";
        transparencyBounds.appendChild(transparencyMinimum);
        transparencyBounds.appendChild(transparencyMaximum);
        transparencySection.appendChild(transparencyTitle);
        transparencySection.appendChild(transparencyDescription);
        transparencySection.appendChild(transparencyHeader);
        transparencySection.appendChild(transparencySlider);
        transparencySection.appendChild(transparencyBounds);

        resultSection.className = "settings-section";
        resultTitle.className = "settings-section-title";
        resultTitle.textContent = "Search results";
        resultDescription.className = "settings-section-description";
        resultDescription.textContent = "Choose how many autocomplete results are shown while searching.";
        resultHeader.className = "settings-range-header";
        resultLabel.className = "settings-range-label";
        resultLabel.textContent = "Results shown";
        resultLabel.htmlFor = "result-limit";
        resultValue.className = "settings-range-value";
        resultValue.textContent = String(selectedResultLimit);
        resultValue.setAttribute("for", "result-limit");
        resultHeader.appendChild(resultLabel);
        resultHeader.appendChild(resultValue);
        resultSlider.id = "result-limit";
        resultSlider.className = "settings-range";
        resultSlider.type = "range";
        resultSlider.min = String(minimumResultLimit);
        resultSlider.max = String(maximumResultLimit);
        resultSlider.step = "1";
        resultSlider.value = String(selectedResultLimit);
        resultSlider.setAttribute("aria-valuemin", String(minimumResultLimit));
        resultSlider.setAttribute("aria-valuemax", String(maximumResultLimit));
        resultSlider.addEventListener("input", () => applyResultLimit(resultSlider.value));
        resultBounds.className = "settings-range-bounds";
        resultBounds.setAttribute("aria-hidden", "true");
        resultMinimum.textContent = String(minimumResultLimit);
        resultMaximum.textContent = String(maximumResultLimit);
        resultBounds.appendChild(resultMinimum);
        resultBounds.appendChild(resultMaximum);
        resultSection.appendChild(resultTitle);
        resultSection.appendChild(resultDescription);
        resultSection.appendChild(resultHeader);
        resultSection.appendChild(resultSlider);
        resultSection.appendChild(resultBounds);

        luckySection.className = "settings-section";
        luckyTitle.className = "settings-section-title";
        luckyTitle.textContent = "Lucky challenge";
        luckyDescription.className = "settings-section-description";
        luckyDescription.textContent = "Tune the route length and how well-connected each random endpoint must be.";
        luckyHeader.className = "settings-range-header";
        luckyLabel.className = "settings-range-label";
        luckyLabel.textContent = "Required connections";
        luckyLabel.htmlFor = "lucky-connections";
        luckyValue.className = "settings-range-value";
        luckyValue.textContent = String(selectedLuckyConnections);
        luckyValue.setAttribute("for", "lucky-connections");
        luckyHeader.appendChild(luckyLabel);
        luckyHeader.appendChild(luckyValue);
        luckySlider.id = "lucky-connections";
        luckySlider.className = "settings-range";
        luckySlider.type = "range";
        luckySlider.min = String(minimumLuckyConnections);
        luckySlider.max = String(maximumLuckyConnections);
        luckySlider.step = "1";
        luckySlider.value = String(selectedLuckyConnections);
        luckySlider.setAttribute("aria-valuemin", String(minimumLuckyConnections));
        luckySlider.setAttribute("aria-valuemax", String(maximumLuckyConnections));
        luckySlider.setAttribute(
            "aria-valuetext",
            `${selectedLuckyConnections} connection${selectedLuckyConnections === 1 ? "" : "s"}`
        );
        luckySlider.addEventListener(
            "input",
            () => applyLuckyConnections(luckySlider.value)
        );
        luckyBounds.className = "settings-range-bounds";
        luckyBounds.setAttribute("aria-hidden", "true");
        luckyMinimum.textContent = "1 (direct)";
        luckyMaximum.textContent = String(maximumLuckyConnections);
        luckyBounds.appendChild(luckyMinimum);
        luckyBounds.appendChild(luckyMaximum);
        luckySection.appendChild(luckyTitle);
        luckySection.appendChild(luckyDescription);
        luckySection.appendChild(luckyHeader);
        luckySection.appendChild(luckySlider);
        luckySection.appendChild(luckyBounds);
        linkedSongsHeader.className = "settings-range-header settings-subcontrol";
        linkedSongsLabel.className = "settings-range-label";
        linkedSongsLabel.textContent = "Required linked songs";
        linkedSongsLabel.htmlFor = "lucky-linked-songs";
        linkedSongsValue.className = "settings-range-value";
        linkedSongsValue.textContent = String(selectedLuckyLinkedSongs);
        linkedSongsValue.setAttribute("for", "lucky-linked-songs");
        linkedSongsHeader.appendChild(linkedSongsLabel);
        linkedSongsHeader.appendChild(linkedSongsValue);
        linkedSongsSlider.id = "lucky-linked-songs";
        linkedSongsSlider.className = "settings-range";
        linkedSongsSlider.type = "range";
        linkedSongsSlider.min = String(minimumLuckyLinkedSongs);
        linkedSongsSlider.max = String(maximumLuckyLinkedSongs);
        linkedSongsSlider.step = "1";
        linkedSongsSlider.value = String(selectedLuckyLinkedSongs);
        linkedSongsSlider.setAttribute("aria-valuemin", String(minimumLuckyLinkedSongs));
        linkedSongsSlider.setAttribute("aria-valuemax", String(maximumLuckyLinkedSongs));
        linkedSongsSlider.setAttribute(
            "aria-valuetext",
            `${selectedLuckyLinkedSongs} linked song${selectedLuckyLinkedSongs === 1 ? "" : "s"}`
        );
        linkedSongsSlider.addEventListener(
            "input",
            () => applyLuckyLinkedSongs(linkedSongsSlider.value)
        );
        linkedSongsBounds.className = "settings-range-bounds";
        linkedSongsBounds.setAttribute("aria-hidden", "true");
        linkedSongsMinimum.textContent = String(minimumLuckyLinkedSongs);
        linkedSongsMaximum.textContent = String(maximumLuckyLinkedSongs);
        linkedSongsBounds.appendChild(linkedSongsMinimum);
        linkedSongsBounds.appendChild(linkedSongsMaximum);
        luckySection.appendChild(linkedSongsHeader);
        luckySection.appendChild(linkedSongsSlider);
        luckySection.appendChild(linkedSongsBounds);

        contactSection.className = "settings-section settings-contact settings-future";
        contactTitle.className = "settings-section-title";
        contactTitle.textContent = "Requests and Feedback";
        contactDescription.className = "settings-section-description";
        contactDescription.textContent = "Found a bug, have an idea on how we can improve the game, or want your favourite artist/song to be added to the database? Please contact us at contact@romoboss.com";
        contactSection.appendChild(contactTitle);
        contactSection.appendChild(contactDescription);

        panel.appendChild(header);
        panel.appendChild(appearanceSection);
        panel.appendChild(transparencySection);
        panel.appendChild(resultSection);
        panel.appendChild(luckySection);
        panel.appendChild(contactSection);

        function openPanel() {
            panel.hidden = false;
            scrim.hidden = false;
            if (pageContent) pageContent.inert = true;
            previousBodyOverflow = document.body.style.overflow || "";
            document.body.style.overflow = "hidden";
            launcher.setAttribute("aria-expanded", "true");
            closeButton.focus();
        }

        function closePanel() {
            panel.hidden = true;
            scrim.hidden = true;
            if (pageContent) pageContent.inert = false;
            document.body.style.overflow = previousBodyOverflow;
            launcher.setAttribute("aria-expanded", "false");
            launcher.focus();
        }

        launcher.addEventListener("click", () => panel.hidden ? openPanel() : closePanel());
        closeButton.addEventListener("click", closePanel);
        scrim.addEventListener("click", closePanel);
        document.addEventListener("keydown", event => {
            if (panel.hidden) return;
            if (event.key === "Escape") {
                closePanel();
                return;
            }
            if (event.key !== "Tab" || typeof panel.querySelectorAll !== "function") return;

            const focusable = [...panel.querySelectorAll(
                "button:not([disabled]), select:not([disabled]), input:not([disabled]), "
                + "a[href], [tabindex]:not([tabindex='-1'])"
            )];
            if (focusable.length === 0) return;

            const first = focusable[0];
            const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        });

        document.body.appendChild(scrim);
        document.body.appendChild(panel);
        document.body.appendChild(launcherContainer);
        applyTheme(selectedTheme, false);
        applyResultLimit(selectedResultLimit, false);
        applyUiTransparency(selectedUiTransparency, false);
        applyLuckyConnections(selectedLuckyConnections, false);
        applyLuckyLinkedSongs(selectedLuckyLinkedSongs, false);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initializeSettings, { once: true });
    } else {
        initializeSettings();
    }
})();

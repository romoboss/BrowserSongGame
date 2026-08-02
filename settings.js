(() => {
    const themeStorageKey = "music-link-theme";
    const resultLimitStorageKey = "music-link-result-limit";
    const uiTransparencyStorageKey = "music-link-ui-transparency";
    const defaultResultLimit = 10;
    const minimumResultLimit = 1;
    const maximumResultLimit = 25;
    const defaultUiTransparency = 48;
    const minimumUiTransparency = 0;
    const maximumUiTransparency = 80;
    const themes = [
        { id: "white", label: "White" },
        { id: "grey", label: "Light Grey" },
        { id: "black", label: "Dark Grey" },
        { id: "oled-black", label: "Black" },
        { id: "blue", label: "Blue" },
        { id: "dark-blue", label: "Dark Blue" },
        { id: "purple", label: "Purple" },
        { id: "dark-purple", label: "Dark Purple" },
        { id: "red", label: "Red" },
        { id: "dark-red", label: "Dark Red" },
        { id: "green", label: "Green" },
        { id: "dark-green", label: "Dark Green" },
        { id: "yellow", label: "Yellow" },
        { id: "dark-yellow", label: "Dark Yellow" },
        { id: "cyan", label: "Cyan" },
        { id: "dark-cyan", label: "Dark Cyan" },
        { id: "pink", label: "Pink" },
        { id: "dark-pink", label: "Dark Pink" }
    ];
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
        const transparency = Number(value);
        return Number.isInteger(transparency)
            && transparency >= minimumUiTransparency
            && transparency <= maximumUiTransparency
            ? transparency
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

    function addSettingsToLink(href, theme, resultLimit, transparency) {
        const [beforeHash, hash = ""] = String(href).split("#", 2);
        const [path, query = ""] = beforeHash.split("?", 2);
        const parameters = new URLSearchParams(query);
        parameters.set("theme", theme);
        parameters.set("limit", String(resultLimit));
        parameters.set("transparency", String(transparency));
        return `${path}?${parameters}${hash ? `#${hash}` : ""}`;
    }

    function updateSettingsLinks(theme, resultLimit, transparency) {
        if (typeof document.querySelectorAll !== "function") return;

        for (const link of document.querySelectorAll("a[data-preserve-theme]")) {
            const href = link.getAttribute("href");
            if (href) {
                link.setAttribute(
                    "href",
                    addSettingsToLink(href, theme, resultLimit, transparency)
                );
            }
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

    let selectedTheme = readLocationTheme() || readStoredTheme();
    let selectedResultLimit = readLocationResultLimit() ?? readStoredResultLimit();
    let selectedUiTransparency = readLocationUiTransparency() ?? readStoredUiTransparency();
    document.documentElement.dataset.theme = selectedTheme;
    document.documentElement.dataset.resultLimit = String(selectedResultLimit);
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
        const appearanceSection = document.createElement("div");
        const appearanceTitle = document.createElement("h3");
        const appearanceDescription = document.createElement("p");
        const options = document.createElement("div");
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
        const contactSection = document.createElement("div");
        const contactTitle = document.createElement("h3");
        const contactDescription = document.createElement("p");
        const optionButtons = [];

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
        closeButton.textContent = "×";
        closeButton.setAttribute("aria-label", "Close settings");
        header.appendChild(title);
        header.appendChild(closeButton);

        appearanceSection.className = "settings-section";
        appearanceTitle.className = "settings-section-title";
        appearanceTitle.textContent = "Appearance";
        appearanceDescription.className = "settings-section-description";
        appearanceDescription.textContent = "Choose a color theme for every page.";
        options.className = "theme-options";
        options.setAttribute("role", "group");
        options.setAttribute("aria-label", "Color theme");

        function applyTheme(theme, persist = true) {
            selectedTheme = normalizeTheme(theme) || "white";
            document.documentElement.dataset.theme = selectedTheme;
            for (const button of optionButtons) {
                button.setAttribute("aria-pressed", String(button.dataset.theme === selectedTheme));
            }
            updateSettingsLinks(selectedTheme, selectedResultLimit, selectedUiTransparency);
            if (persist) storeTheme(selectedTheme);
        }

        function applyResultLimit(resultLimit, persist = true) {
            selectedResultLimit = parseResultLimit(resultLimit) ?? defaultResultLimit;
            document.documentElement.dataset.resultLimit = String(selectedResultLimit);
            resultSlider.value = String(selectedResultLimit);
            resultValue.textContent = String(selectedResultLimit);
            updateSettingsLinks(selectedTheme, selectedResultLimit, selectedUiTransparency);
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
            updateSettingsLinks(selectedTheme, selectedResultLimit, selectedUiTransparency);
            if (persist) storeUiTransparency(selectedUiTransparency);
        }

        for (const theme of themes) {
            const button = document.createElement("button");
            const swatch = document.createElement("span");
            const label = document.createElement("span");

            button.type = "button";
            button.className = "theme-option";
            button.dataset.theme = theme.id;
            button.setAttribute("aria-label", `${theme.label} theme`);
            button.setAttribute("aria-pressed", "false");
            swatch.className = `theme-swatch theme-swatch-${theme.id}`;
            swatch.setAttribute("aria-hidden", "true");
            label.textContent = theme.label;
            button.appendChild(swatch);
            button.appendChild(label);
            button.addEventListener("click", () => applyTheme(theme.id));
            optionButtons.push(button);
            options.appendChild(button);
        }

        appearanceSection.appendChild(appearanceTitle);
        appearanceSection.appendChild(appearanceDescription);
        appearanceSection.appendChild(options);

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
        panel.appendChild(contactSection);

        function openPanel() {
            panel.hidden = false;
            scrim.hidden = false;
            launcher.setAttribute("aria-expanded", "true");
            closeButton.focus();
        }

        function closePanel() {
            panel.hidden = true;
            scrim.hidden = true;
            launcher.setAttribute("aria-expanded", "false");
            launcher.focus();
        }

        launcher.addEventListener("click", () => panel.hidden ? openPanel() : closePanel());
        closeButton.addEventListener("click", closePanel);
        scrim.addEventListener("click", closePanel);
        document.addEventListener("keydown", event => {
            if (event.key === "Escape" && !panel.hidden) closePanel();
        });

        document.body.appendChild(scrim);
        document.body.appendChild(panel);
        document.body.appendChild(launcherContainer);
        applyTheme(selectedTheme, false);
        applyResultLimit(selectedResultLimit, false);
        applyUiTransparency(selectedUiTransparency, false);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initializeSettings, { once: true });
    } else {
        initializeSettings();
    }
})();

(() => {
    const storageKey = "music-link-theme";
    const themes = [
        { id: "white", label: "White" },
        { id: "grey", label: "Grey" },
        { id: "black", label: "Black" },
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

    function readLocationTheme() {
        try {
            const theme = new URLSearchParams(globalThis.location?.search || "").get("theme");
            return validThemes.has(theme) ? theme : null;
        } catch {
            return null;
        }
    }

    function readStoredTheme() {
        try {
            const storedTheme = globalThis.localStorage?.getItem(storageKey);
            return validThemes.has(storedTheme) ? storedTheme : "white";
        } catch {
            return "white";
        }
    }

    function storeTheme(theme) {
        try {
            globalThis.localStorage?.setItem(storageKey, theme);
        } catch {
            // Theme changes still work for this page when file storage is unavailable.
        }
    }

    function addThemeToLink(href, theme) {
        const [beforeHash, hash = ""] = String(href).split("#", 2);
        const [path, query = ""] = beforeHash.split("?", 2);
        const parameters = new URLSearchParams(query);
        parameters.set("theme", theme);
        return `${path}?${parameters}${hash ? `#${hash}` : ""}`;
    }

    function updateThemeLinks(theme) {
        if (typeof document.querySelectorAll !== "function") return;

        for (const link of document.querySelectorAll("a[data-preserve-theme]")) {
            const href = link.getAttribute("href");
            if (href) link.setAttribute("href", addThemeToLink(href, theme));
        }
    }

    let selectedTheme = readLocationTheme() || readStoredTheme();
    document.documentElement.dataset.theme = selectedTheme;

    function initializeSettings() {
        if (!document.body || document.getElementById("settings-button")) return;

        const launcher = document.createElement("button");
        const launcherIcon = document.createElement("span");
        const scrim = document.createElement("div");
        const panel = document.createElement("aside");
        const header = document.createElement("header");
        const title = document.createElement("h2");
        const closeButton = document.createElement("button");
        const appearanceSection = document.createElement("section");
        const appearanceTitle = document.createElement("h3");
        const appearanceDescription = document.createElement("p");
        const options = document.createElement("div");
        const contactSection = document.createElement("section");
        const contactTitle = document.createElement("h3");
        const contactDescription = document.createElement("p");
        const optionButtons = [];

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

        scrim.className = "settings-scrim";
        scrim.hidden = true;
        scrim.setAttribute("aria-hidden", "true");

        panel.id = "settings-panel";
        panel.className = "settings-panel";
        panel.hidden = true;
        panel.setAttribute("role", "dialog");
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
            selectedTheme = validThemes.has(theme) ? theme : "white";
            document.documentElement.dataset.theme = selectedTheme;
            for (const button of optionButtons) {
                button.setAttribute("aria-pressed", String(button.dataset.theme === selectedTheme));
            }
            updateThemeLinks(selectedTheme);
            if (persist) storeTheme(selectedTheme);
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

        contactSection.className = "settings-section settings-contact";
        contactTitle.className = "settings-section-title";
        contactTitle.textContent = "Requests and Feedback";
        contactDescription.className = "settings-section-description";
        contactDescription.textContent = "Found a bug, have an idea on how we can improve the game, or want your favourite artist/song to be added to the database? Please contact us at contact@romoboss.com";
        contactSection.appendChild(contactTitle);
        contactSection.appendChild(contactDescription);

        panel.appendChild(header);
        panel.appendChild(appearanceSection);
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
        document.body.appendChild(launcher);
        applyTheme(selectedTheme, false);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initializeSettings, { once: true });
    } else {
        initializeSettings();
    }
})();

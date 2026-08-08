(() => {
    const storageKey = "music-link-sidebar-state";
    const mobileBreakpoint = 760;
    const mobileMediaQuery = `(max-width: ${mobileBreakpoint}px)`;
    const packageMetadataPath = "./package.json";
    const navigationItems = [
        { page: "home", label: "Home", href: "./" },
        { page: "route-picker", label: "Route Picker", href: "./route-picker" },
        { page: "daily", label: "Daily Challenge", href: "./daily" },
        { page: "archive", label: "Daily Archive", href: "./archive" },
        { page: "privacy", label: "Privacy Policy", href: "./privacy" },
        {
            page: null,
            label: "Main Website",
            href: "https://romoboss.com/",
            external: true
        }
    ];

    function readStoredState() {
        try {
            const storedState = globalThis.localStorage?.getItem(storageKey);
            if (storedState === "open" || storedState === "true") return true;
            if (storedState === "closed" || storedState === "false") return false;
        } catch {
            // Navigation still works when browser storage is unavailable.
        }
        return null;
    }

    function storeState(isOpen) {
        try {
            globalThis.localStorage?.setItem(storageKey, isOpen ? "open" : "closed");
        } catch {
            // Keep the state for this page when browser storage is unavailable.
        }
    }

    function getMobileQuery() {
        try {
            return typeof globalThis.matchMedia === "function"
                ? globalThis.matchMedia(mobileMediaQuery)
                : null;
        } catch {
            return null;
        }
    }

    function isMobileViewport(mobileQuery) {
        if (mobileQuery) return mobileQuery.matches;
        return Number(globalThis.innerWidth) <= mobileBreakpoint;
    }

    function setAttributes(element, attributes) {
        for (const [name, value] of Object.entries(attributes)) {
            element.setAttribute(name, value);
        }
        return element;
    }

    function createNavigationLink(item, currentPage) {
        const listItem = document.createElement("li");
        listItem.className = "site-nav-item";

        const link = document.createElement("a");
        link.className = "site-nav-link";
        link.href = item.href;
        link.textContent = item.label;

        if (item.external) {
            link.classList.add("site-nav-link-external");
        }

        if (item.page && item.page === currentPage) {
            link.classList.add("site-nav-link-current");
            link.setAttribute("aria-current", "page");
        }

        listItem.appendChild(link);
        return listItem;
    }

    async function loadWebsiteVersion(element) {
        if (typeof globalThis.fetch !== "function") return;

        try {
            const response = await globalThis.fetch(packageMetadataPath, { cache: "no-store" });
            if (!response.ok) return;

            const packageMetadata = await response.json();
            const websiteVersion = typeof packageMetadata?.version === "string"
                ? packageMetadata.version.trim()
                : "";
            if (!websiteVersion) return;

            element.setAttribute("aria-label", `Website version ${websiteVersion}`);
            element.textContent = `Website v${websiteVersion}`;
        } catch {
            // Navigation remains usable if the static configuration is unavailable.
        }
    }

    function getCurrentPage(body) {
        const declaredPage = body.dataset.page || "";
        if (declaredPage !== "game" && declaredPage !== "results") return declaredPage;

        try {
            const source = declaredPage === "results"
                ? (globalThis.location?.hash || "").replace(/^#/, "")
                : globalThis.location?.search || "";
            const parameters = new URLSearchParams(source);
            if (!parameters.get("daily")) return "route-picker";
            return parameters.get("archive") === "1" ? "archive" : "daily";
        } catch {
            return "route-picker";
        }
    }

    function initializeNavigation() {
        const body = document.body;
        if (!body || document.getElementById("site-sidebar")) return;

        const mobileQuery = getMobileQuery();
        let hasStoredPreference = readStoredState() !== null;
        let isOpen = readStoredState() ?? !isMobileViewport(mobileQuery);

        const toggle = setAttributes(document.createElement("button"), {
            id: "site-nav-toggle",
            type: "button",
            "aria-controls": "site-sidebar"
        });
        toggle.className = "site-nav-toggle";

        const toggleIcon = document.createElement("span");
        toggleIcon.className = "site-nav-toggle-icon";
        toggleIcon.setAttribute("aria-hidden", "true");
        toggle.appendChild(toggleIcon);

        const toggleText = document.createElement("span");
        toggleText.className = "site-nav-toggle-text";
        toggleText.textContent = "Menu";
        toggle.appendChild(toggleText);

        const sidebar = setAttributes(document.createElement("aside"), {
            id: "site-sidebar",
            "aria-label": "Site navigation"
        });
        sidebar.className = "site-sidebar";

        const header = document.createElement("div");
        header.className = "site-nav-header";

        const brand = document.createElement("a");
        brand.className = "site-nav-brand";
        brand.href = "./";
        brand.textContent = "Songaveler";
        header.appendChild(brand);
        sidebar.appendChild(header);

        const nav = document.createElement("nav");
        nav.className = "site-nav-menu";
        nav.setAttribute("aria-label", "Primary navigation");

        const list = document.createElement("ul");
        list.className = "site-nav-list";
        const currentPage = getCurrentPage(body);
        for (const item of navigationItems) {
            list.appendChild(createNavigationLink(item, currentPage));
        }
        nav.appendChild(list);
        sidebar.appendChild(nav);

        const version = document.createElement("footer");
        version.className = "site-nav-version";
        version.setAttribute("aria-label", "Website version");
        version.textContent = "Website";
        sidebar.appendChild(version);
        void loadWebsiteVersion(version);

        const overlay = setAttributes(document.createElement("button"), {
            id: "site-nav-overlay",
            type: "button",
            "aria-label": "Close navigation",
            tabindex: "-1"
        });
        overlay.className = "site-nav-overlay";

        function applyState(nextState, persist = false) {
            isOpen = Boolean(nextState);
            const isMobile = isMobileViewport(mobileQuery);

            body.classList.toggle("site-nav-open", isOpen);
            sidebar.classList.toggle("site-sidebar-open", isOpen);
            sidebar.setAttribute("aria-hidden", String(!isOpen));
            sidebar.inert = !isOpen;
            toggle.setAttribute("aria-expanded", String(isOpen));
            toggle.setAttribute("aria-label", isOpen ? "Close navigation" : "Open navigation");
            overlay.hidden = !isOpen || !isMobile;

            if (persist) {
                hasStoredPreference = true;
                storeState(isOpen);
            }
        }

        toggle.addEventListener("click", () => applyState(!isOpen, true));
        overlay.addEventListener("click", () => {
            if (!isMobileViewport(mobileQuery)) return;
            applyState(false, true);
            toggle.focus();
        });
        document.addEventListener("keydown", event => {
            if (event.key !== "Escape" || !isOpen) return;
            applyState(false, true);
            toggle.focus();
        });

        const handleViewportChange = event => {
            if (hasStoredPreference) {
                applyState(isOpen);
                return;
            }
            applyState(!event.matches);
        };
        if (typeof mobileQuery?.addEventListener === "function") {
            mobileQuery.addEventListener("change", handleViewportChange);
        } else if (typeof mobileQuery?.addListener === "function") {
            mobileQuery.addListener(handleViewportChange);
        }

        body.classList.add("site-nav-enabled");
        body.appendChild(toggle);
        body.appendChild(sidebar);
        body.appendChild(overlay);
        applyState(isOpen);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initializeNavigation, { once: true });
    } else {
        initializeNavigation();
    }
})();

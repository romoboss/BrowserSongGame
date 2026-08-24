import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageMetadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
);
const navigationSource = await readFile(
    new URL("../js/navigation.js", import.meta.url),
    "utf8"
);

test("the static navigation version stays in sync with package metadata", () => {
    assert.match(packageMetadata.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
    const versionMatch = navigationSource.match(/const websiteVersion = "([^"]+)";/);
    assert.ok(versionMatch, "Expected navigation to declare its static website version");
    assert.equal(versionMatch[1], packageMetadata.version);
    assert.doesNotMatch(navigationSource, /fetch\s*\(/);
    assert.doesNotMatch(navigationSource, /\.\/package\.json/);
});

class TestElement {
    constructor(tagName, id = "") {
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this.attributes = new Map();
        this.children = [];
        this.dataset = {};
        this.hidden = false;
        this.href = "";
        this.inert = false;
        this.listeners = new Map();
        this.parentNode = null;
        this.textContent = "";
        this.focused = false;
        const classes = new Set();
        Object.defineProperty(this, "className", {
            get: () => [...classes].join(" "),
            set: value => {
                classes.clear();
                String(value).split(/\s+/).filter(Boolean).forEach(name => classes.add(name));
            }
        });
        this.classList = {
            add: (...names) => names.forEach(name => classes.add(name)),
            contains: name => classes.has(name),
            toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
        };
    }

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    async dispatch(type, event = {}) {
        await Promise.all((this.listeners.get(type) || []).map(listener => listener(event)));
    }

    focus() {
        this.focused = true;
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === "id") this.id = String(value);
    }
}

function findElement(root, predicate) {
    if (predicate(root)) return root;
    for (const child of root.children) {
        const match = findElement(child, predicate);
        if (match) return match;
    }
    return null;
}

function findElements(root, predicate, matches = []) {
    if (predicate(root)) matches.push(root);
    for (const child of root.children) findElements(child, predicate, matches);
    return matches;
}

function installEnvironment({
    mobile = false,
    page = "home",
    storedState = null,
    loading = false,
    search = "",
    hash = ""
}) {
    const body = new TestElement("body", "body");
    body.dataset.page = page;
    const documentListeners = new Map();
    const mediaListeners = [];
    const fetchRequests = [];
    const storedValues = new Map();
    if (storedState !== null) storedValues.set("music-link-sidebar-state", storedState);

    globalThis.localStorage = {
        getItem: key => storedValues.get(key) ?? null,
        setItem: (key, value) => storedValues.set(key, String(value))
    };
    globalThis.location = { search, hash };
    globalThis.matchMedia = query => ({
        media: query,
        matches: mobile,
        addEventListener(type, listener) {
            if (type === "change") mediaListeners.push(listener);
        }
    });
    globalThis.fetch = async (url, options) => {
        fetchRequests.push({ url, options });
        return {
            ok: true,
            async json() {
                return { version: packageMetadata.version };
            }
        };
    };
    globalThis.document = {
        body,
        readyState: loading ? "loading" : "complete",
        createElement: tagName => new TestElement(tagName),
        getElementById(id) {
            return findElement(body, element => element.id === id);
        },
        addEventListener(type, listener) {
            const listeners = documentListeners.get(type) || [];
            listeners.push(listener);
            documentListeners.set(type, listeners);
        }
    };

    return {
        body,
        fetchRequests,
        storedValues,
        async dispatchDocument(type, event = {}) {
            await Promise.all(
                (documentListeners.get(type) || []).map(listener => listener(event))
            );
        }
    };
}

async function loadNavigation(caseName) {
    await import(new URL(`../js/navigation.js?case=${caseName}`, import.meta.url));
    await new Promise(resolve => setImmediate(resolve));
}

test("injects an accessible desktop sidebar and marks the current page", async () => {
    const { body, fetchRequests } = installEnvironment({ page: "route-picker" });
    await loadNavigation("desktop");

    const toggle = findElement(body, element => element.id === "site-nav-toggle");
    const sidebar = findElement(body, element => element.id === "site-sidebar");
    const overlay = findElement(body, element => element.id === "site-nav-overlay");
    const links = findElements(body, element => element.classList.contains("site-nav-link"));
    const version = findElement(
        body,
        element => element.classList.contains("site-nav-version")
    );

    assert.ok(toggle);
    assert.ok(sidebar);
    assert.ok(overlay);
    assert.equal(body.classList.contains("site-nav-enabled"), true);
    assert.equal(body.classList.contains("site-nav-open"), true);
    assert.equal(toggle.getAttribute("aria-controls"), "site-sidebar");
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.getAttribute("aria-label"), "Close navigation");
    assert.equal(sidebar.getAttribute("aria-hidden"), "false");
    assert.equal(sidebar.inert, false);
    assert.equal(overlay.hidden, true);
    assert.deepEqual(
        links.map(link => [link.textContent, link.href]),
        [
            ["Home", "./"],
            ["Route Picker", "./route-picker"],
            ["Daily Challenge", "./daily"],
            ["Daily Archive", "./archive"],
            ["Privacy Policy", "./privacy"],
            ["Main Website", "https://romoboss.com/"]
        ]
    );
    assert.equal(links[1].getAttribute("aria-current"), "page");
    assert.equal(links[1].classList.contains("site-nav-link-current"), true);
    assert.equal(links[5].classList.contains("site-nav-link-external"), true);
    assert.equal(links.filter(link => link.getAttribute("aria-current") === "page").length, 1);
    assert.ok(version);
    assert.equal(version.tagName, "FOOTER");
    assert.equal(version.textContent, `Website v${packageMetadata.version}`);
    assert.equal(version.getAttribute("aria-label"), `Website version ${packageMetadata.version}`);
    assert.deepEqual(fetchRequests, []);
});

test("the toggle persists open and closed states", async () => {
    const { body, storedValues } = installEnvironment({ storedState: "open" });
    await loadNavigation("persistence");

    const toggle = findElement(body, element => element.id === "site-nav-toggle");
    const sidebar = findElement(body, element => element.id === "site-sidebar");
    await toggle.dispatch("click");

    assert.equal(body.classList.contains("site-nav-open"), false);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(sidebar.getAttribute("aria-hidden"), "true");
    assert.equal(sidebar.inert, true);
    assert.equal(storedValues.get("music-link-sidebar-state"), "closed");

    await toggle.dispatch("click");
    assert.equal(body.classList.contains("site-nav-open"), true);
    assert.equal(storedValues.get("music-link-sidebar-state"), "open");
});

test("defaults closed on mobile and its overlay closes an open sidebar", async () => {
    const { body, storedValues } = installEnvironment({ mobile: true, page: "daily" });
    await loadNavigation("mobile-overlay");

    const toggle = findElement(body, element => element.id === "site-nav-toggle");
    const overlay = findElement(body, element => element.id === "site-nav-overlay");
    const dailyLink = findElement(
        body,
        element => element.textContent === "Daily Challenge" && element.tagName === "A"
    );
    assert.equal(body.classList.contains("site-nav-open"), false);
    assert.equal(overlay.hidden, true);
    assert.equal(dailyLink.getAttribute("aria-current"), "page");

    await toggle.dispatch("click");
    assert.equal(body.classList.contains("site-nav-open"), true);
    assert.equal(overlay.hidden, false);

    await overlay.dispatch("click");
    assert.equal(body.classList.contains("site-nav-open"), false);
    assert.equal(storedValues.get("music-link-sidebar-state"), "closed");
    assert.equal(toggle.focused, true);
});

test("marks the privacy policy as the current menu page", async () => {
    const { body } = installEnvironment({ mobile: true, page: "privacy" });
    await loadNavigation("privacy-current");

    const privacyLink = findElement(
        body,
        element => element.textContent === "Privacy Policy" && element.tagName === "A"
    );
    assert.ok(privacyLink);
    assert.equal(privacyLink.href, "./privacy");
    assert.equal(privacyLink.getAttribute("aria-current"), "page");
    assert.equal(privacyLink.classList.contains("site-nav-link-current"), true);
});

test("marks the daily archive as the current menu page", async () => {
    const { body } = installEnvironment({ mobile: true, page: "archive" });
    await loadNavigation("archive-current");

    const archiveLink = findElement(
        body,
        element => element.textContent === "Daily Archive" && element.tagName === "A"
    );
    assert.ok(archiveLink);
    assert.equal(archiveLink.href, "./archive");
    assert.equal(archiveLink.getAttribute("aria-current"), "page");
    assert.equal(archiveLink.classList.contains("site-nav-link-current"), true);
});

test("game and results pages highlight their originating challenge section", async () => {
    let environment = installEnvironment({
        page: "game",
        search: "?start=1&end=3&daily=2031-05-10&archive=1"
    });
    await loadNavigation("archive-game-context");
    let currentLink = findElement(
        environment.body,
        element => element.getAttribute("aria-current") === "page"
    );
    assert.equal(currentLink.textContent, "Daily Archive");

    environment = installEnvironment({
        page: "results",
        hash: "#v=1&daily=2031-05-10"
    });
    await loadNavigation("daily-results-context");
    currentLink = findElement(
        environment.body,
        element => element.getAttribute("aria-current") === "page"
    );
    assert.equal(currentLink.textContent, "Daily Challenge");
});

test("Escape closes the sidebar and DOM loading defers injection", async () => {
    const { body, storedValues, dispatchDocument } = installEnvironment({ loading: true });
    await loadNavigation("escape-loading");
    assert.equal(findElement(body, element => element.id === "site-sidebar"), null);

    await dispatchDocument("DOMContentLoaded");
    const toggle = findElement(body, element => element.id === "site-nav-toggle");
    assert.ok(toggle);
    assert.equal(body.classList.contains("site-nav-open"), true);

    await dispatchDocument("keydown", { key: "Escape" });
    assert.equal(body.classList.contains("site-nav-open"), false);
    assert.equal(storedValues.get("music-link-sidebar-state"), "closed");
    assert.equal(toggle.focused, true);
});

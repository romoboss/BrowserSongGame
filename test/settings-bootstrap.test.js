import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

let importNumber = 0;

async function runBootstrap({ search = "", storedValues = {} } = {}) {
    const storage = new Map(Object.entries(storedValues));
    const writes = [];
    let replacedUrl = null;

    globalThis.localStorage = {
        getItem: key => storage.get(key) ?? null,
        setItem(key, value) {
            storage.set(key, String(value));
            writes.push([key, String(value)]);
        }
    };
    globalThis.document = {
        documentElement: {
            dataset: {},
            style: {
                setProperty(name, value) {
                    this[name] = value;
                }
            }
        }
    };
    globalThis.location = {
        search,
        pathname: "/game",
        hash: "#route"
    };
    globalThis.history = {
        state: { preserved: true },
        replaceState(state, title, url) {
            assert.deepEqual(state, { preserved: true });
            assert.equal(title, "");
            replacedUrl = url;
        }
    };

    importNumber += 1;
    await import(`../js/settings-bootstrap.js?bootstrap-test=${importNumber}`);
    return {
        dataset: document.documentElement.dataset,
        opacity: document.documentElement.style["--ui-panel-opacity"],
        replacedUrl,
        state: globalThis.SongavelerSettingsBootstrap,
        writes
    };
}

test("prepaint bootstrap applies stored and legacy-link settings before the UI loads", async () => {
    const result = await runBootstrap({
        search: "?start=1&theme=dark-blue&limit=18&transparency=62",
        storedValues: {
            "music-link-lucky-connections": "4",
            "music-link-lucky-linked-songs": "40"
        }
    });

    assert.deepEqual({ ...result.dataset }, {
        theme: "dark-blue",
        resultLimit: "18",
        uiTransparency: "62",
        luckyConnections: "4",
        luckyLinkedSongs: "40"
    });
    assert.equal(result.opacity, "38%");
    assert.equal(result.replacedUrl, "/game?start=1#route");
    assert.deepEqual(result.writes, [
        ["music-link-theme", "dark-blue"],
        ["music-link-result-limit", "18"],
        ["music-link-ui-transparency", "62"]
    ]);
    assert.equal(result.state.theme, "dark-blue");
});

test("every page runs the small bootstrap before loading the deferred settings UI", async () => {
    for (const page of [
        "index.html",
        "route-picker.html",
        "daily.html",
        "archive.html",
        "game.html",
        "results.html",
        "privacy.html"
    ]) {
        const html = await readFile(new URL(`../${page}`, import.meta.url), "utf8");
        const bootstrapIndex = html.indexOf("./js/settings-bootstrap.js");
        const settingsIndex = html.indexOf("./js/settings.js");

        assert.ok(bootstrapIndex >= 0, `${page} must load the prepaint settings bootstrap`);
        assert.ok(settingsIndex > bootstrapIndex, `${page} must load the full settings UI second`);
        assert.match(
            html.slice(settingsIndex, html.indexOf("></script>", settingsIndex) + 1),
            /\bdefer\b/,
            `${page} must defer the full settings UI`
        );
    }
});

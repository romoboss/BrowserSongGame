import assert from "node:assert/strict";
import test from "node:test";
import { FakeElement } from "./helpers.js";

async function loadSettings({ name, storedTransparency }) {
    const body = new FakeElement("body");
    const storedValues = new Map();
    const writes = [];
    let replacedUrl = null;

    if (storedTransparency !== undefined) {
        storedValues.set("music-link-ui-transparency", storedTransparency);
    }

    globalThis.localStorage = {
        getItem: key => storedValues.get(key) ?? null,
        setItem(key, value) {
            const stringValue = String(value);
            writes.push([key, stringValue]);
            storedValues.set(key, stringValue);
        }
    };
    globalThis.document = {
        body,
        documentElement: {
            dataset: {},
            style: {
                setProperty(property, value) {
                    this[property] = value;
                }
            }
        },
        readyState: "complete",
        createElement: () => new FakeElement(),
        getElementById: () => null,
        addEventListener() {}
    };
    globalThis.location = { search: "", pathname: "/index.html", hash: "" };
    globalThis.history = {
        state: null,
        replaceState(state, title, url) {
            replacedUrl = url;
        }
    };

    await import(`../js/settings.js?clean-transparency-${name}`);

    return {
        opacity: document.documentElement.style["--ui-panel-opacity"],
        replacedUrl,
        storedValues,
        transparency: document.documentElement.dataset.uiTransparency,
        transparencyWrites: writes.filter(
            ([key]) => key === "music-link-ui-transparency"
        )
    };
}

test("a clean URL reads transparency from storage without overwriting it", async () => {
    const scenarios = [
        { name: "stored-30", storedTransparency: "30", expected: "30", opacity: "70%" },
        { name: "default", storedTransparency: undefined, expected: "48", opacity: "52%" },
        { name: "stored-zero", storedTransparency: "0", expected: "0", opacity: "100%" }
    ];

    for (const scenario of scenarios) {
        const result = await loadSettings(scenario);

        assert.equal(result.transparency, scenario.expected, scenario.name);
        assert.equal(result.opacity, scenario.opacity, scenario.name);
        assert.deepEqual(result.transparencyWrites, [], scenario.name);
        assert.equal(result.replacedUrl, null, scenario.name);
        assert.equal(
            result.storedValues.get("music-link-ui-transparency"),
            scenario.storedTransparency,
            scenario.name
        );
    }
});

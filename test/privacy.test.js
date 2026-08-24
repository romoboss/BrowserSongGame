import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const privacyHtml = readFileSync(new URL("../privacy.html", import.meta.url), "utf8");

test("privacy page is dated, navigable, and describes the implemented data handling", () => {
    assert.match(privacyHtml, /<body class="privacy-page" data-page="privacy">/);
    assert.equal((privacyHtml.match(/datetime="2026-08-03"/g) || []).length, 2);
    assert.match(privacyHtml, /3 August 2026/);
    assert.match(privacyHtml, /browser local storage/);
    assert.match(privacyHtml, /first Daily Challenge attempt/);
    assert.match(privacyHtml, /does not set cookies/);
    assert.match(privacyHtml, /does not use advertising or\s+analytics trackers/);
    assert.match(privacyHtml, /mailto:contact@romoboss\.com/);
    assert.match(privacyHtml, /\.\/js\/navigation\.js\?v=nav-6/);
});

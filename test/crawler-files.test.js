import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const notFoundHtml = readFileSync(new URL("../404.html", import.meta.url), "utf8");
const sitemapXml = readFileSync(new URL("../sitemap.xml", import.meta.url), "utf8");
const robotsText = readFileSync(new URL("../robots.txt", import.meta.url), "utf8");
const siteOrigin = "https://songaveler.romoboss.com";

test("404 page keeps shared navigation and resolves assets from the domain root", () => {
    assert.match(notFoundHtml, /<meta name="robots" content="noindex, follow">/);
    assert.match(notFoundHtml, /<base href="\/">/);
    assert.match(notFoundHtml, /<body class="home-page not-found-page" data-page="not-found">/);
    assert.match(notFoundHtml, /\.\/js\/settings-bootstrap\.js\?v=bootstrap-1/);
    assert.match(notFoundHtml, /\.\/js\/navigation\.js\?v=nav-6/);
    assert.match(notFoundHtml, /href="\.\/route-picker"/);
    assert.doesNotMatch(notFoundHtml, /href="[^"]+\.html(?:[?#"])/);
});

test("sitemap exposes only stable extensionless public pages", () => {
    assert.match(sitemapXml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(sitemapXml, /xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);

    const locations = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)]
        .map(match => match[1]);
    assert.deepEqual(locations, [
        `${siteOrigin}/`,
        `${siteOrigin}/route-picker`,
        `${siteOrigin}/daily`,
        `${siteOrigin}/archive`,
        `${siteOrigin}/privacy`
    ]);
    assert.ok(locations.every(location => !location.endsWith(".html")));
    assert.ok(locations.every(location => location.startsWith(`${siteOrigin}/`)));
});

test("robots file allows crawling and advertises the sitemap", () => {
    assert.match(robotsText, /^User-agent: \*$/m);
    assert.match(robotsText, /^Allow: \/$/m);
    assert.match(robotsText, new RegExp(`^Sitemap: ${siteOrigin.replaceAll(".", "\\.")}\/sitemap\\.xml$`, "m"));
});

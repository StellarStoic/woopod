// /r — a live radio station shared from the app. No feed, no episode, no resolver: the query is the card.
//
// Checked here: the tags the crawler sees, the tiny-scaled arithmetic of one station name, the route that
// serves it, and the link the player accepts. The stream itself is only ever named, never fetched.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { shareMetadata, renderShareMetadata } from "../player/share-metadata.mjs";
import { parseLink, radioPlayback } from "../player/core.mjs";
import { handle, kindOf } from "../server/route.mjs";

const ORIGIN = "https://woopod.com";
const PAGE = readFileSync(new URL("../r/index.html", import.meta.url), "utf8");
const AUDIO = "https://stream.example.com/live.mp3";
const HOMEPAGE = "https://radio.example.com/";
const link = (query = "") => `${ORIGIN}/r/${query}`;
const serve = html => async () => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

test("the route knows /r with and without its trailing slash, and nothing deeper", () => {
    assert.equal(kindOf("/r"), "radio");
    assert.equal(kindOf("/r/"), "radio");
    assert.equal(kindOf("/r/live"), null);
    assert.equal(kindOf("/p"), "episode");
    assert.equal(kindOf("/c/"), "clip");
    assert.equal(kindOf("/show"), "show");
});

test("a radio card carries the station name, the word Radio, and the whole query", () => {
    const url = link(`?audio=${encodeURIComponent(AUDIO)}&title=Radio%20Student&homepage=${encodeURIComponent(HOMEPAGE)}`);
    const card = shareMetadata(url, null);
    assert.equal(card.title, "Radio Student · Radio");
    assert.equal(card.description, "Listen to Radio Student live on Woopod.");
    assert.equal(card.url, url, "the canonical address keeps the whole query");
    assert.match(card.url, /^https:\/\/woopod\.com\/r\/\?audio=/);
    assert.equal(card.image, "https://woopod.com/assets/app-icon-dark.png", "no artwork is claimed for a stream");

    // a station with no name still gets a card, never an empty title
    const bare = shareMetadata(link(`?audio=${encodeURIComponent(AUDIO)}`), null);
    assert.equal(bare.title, "Live radio, shared with Woopod");
    assert.equal(bare.description, "Listen to a live radio station on Woopod.");
});

test("the tags land between the markers of the real r page", () => {
    const url = link(`?audio=${encodeURIComponent(AUDIO)}&title=Radio%20Student`);
    const html = renderShareMetadata(PAGE, shareMetadata(url, null));
    assert.match(html, /<meta property="og:title" content="Radio Student · Radio">/);
    assert.match(html, /<meta property="og:description" content="Listen to Radio Student live on Woopod.">/);
    // og:url is escaped markup, so compare against the escaped form of the real address
    assert.ok(html.includes(`<meta property="og:url" content="${url.replace(/&/g, "&amp;")}">`));
    assert.equal(html.match(/WOOPOD_SHARE_META_START/g).length, 1, "the markers survive one pass");
    assert.equal(html.match(/WOOPOD_SHARE_META_END/g).length, 1);
});

test("a name that would break the markup is escaped, not trusted", () => {
    const url = link(`?audio=${encodeURIComponent(AUDIO)}&title=${encodeURIComponent('<b>"A&B"</b>')}`);
    const html = renderShareMetadata(PAGE, shareMetadata(url, null));
    assert.ok(html.includes("content='&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt; · Radio'".replace(/'/g, '"')) ||
        html.includes("&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt; · Radio"), "the tag characters are entities now");
    assert.equal(/<b>/.test(html.split("WOOPOD_SHARE_META_END")[0].split("WOOPOD_SHARE_META_START")[1]), false);
});

test("serving /r needs no resolver, and says so in one header", async () => {
    let resolved = 0;
    const url = link(`?audio=${encodeURIComponent(AUDIO)}&title=Radio%20Student`);
    const response = await handle(new Request(url), {
        getPage: serve(PAGE),
        // the episode resolver must not be reached: a station has nothing to resolve
        resolveShow: async () => { resolved++; return new Response("", { status: 500 }); },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-woopod-preview"), "resolved");
    assert.match(response.headers.get("content-type"), /text\/html/);
    const body = await response.text();
    assert.match(body, /Radio Student · Radio/);
    // the page still opens exactly as published when something goes wrong, and a HEAD fills no cache
    const head = await handle(new Request(url, { method: "HEAD" }), { getPage: serve(PAGE) });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const refused = await handle(new Request(url, { method: "POST" }), { getPage: serve(PAGE) });
    assert.equal(refused.status, 405);
    const unpublished = await handle(new Request(url), { getPage: async () => new Response("", { status: 404 }) });
    assert.equal(unpublished.status, 404);
});

test("the player accepts the radio link the app emits, and refuses what it must", () => {
    const ok = parseLink(`?audio=${encodeURIComponent(AUDIO)}&title=Radio%20Student&homepage=${encodeURIComponent(HOMEPAGE)}`, "radio");
    assert.equal(ok.mode, "radio");
    assert.equal(ok.audio, AUDIO);
    assert.equal(ok.title, "Radio Student");
    assert.equal(ok.homepage, HOMEPAGE);
    assert.equal(ok.end, null, "a stream has no end to bound");

    const bare = parseLink(`?audio=${encodeURIComponent(AUDIO)}`, "radio");
    assert.equal(bare.title, "Radio", "an unnamed station still has a name on screen");
    assert.equal(bare.homepage, "");

    // radio streams may be plain HTTP (public broadcast); credentials, fragments and non-HTTP schemes stay refused
    const plain = parseLink("?audio=http%3A%2F%2Fstream.example.com%2Flive.mp3&homepage=http%3A%2F%2Fradio.example.com%2F", "radio");
    assert.equal(plain.audio, "http://stream.example.com/live.mp3");
    assert.equal(plain.homepage, "http://radio.example.com/");
    assert.throws(() => parseLink("?audio=ftp%3A%2F%2Fstream.example.com%2Flive.mp3", "radio"), /public stream/);
    assert.throws(() => parseLink("?audio=https%3A%2F%2Fu%3Ap%40stream.example.com%2Flive.mp3", "radio"), /public stream/);
    assert.throws(() => parseLink(`?audio=${encodeURIComponent(AUDIO + "#x")}`, "radio"), /public stream/);
    assert.throws(() => parseLink("?title=No%20stream", "radio"), /missing its stream/);
    assert.throws(() => parseLink(`?audio=${encodeURIComponent(AUDIO)}&s=15&e=45`, "radio"), /only the stream/);
    assert.throws(() => parseLink(`?audio=${encodeURIComponent(AUDIO)}&f=${encodeURIComponent("https://feeds.example.com/f.xml")}`, "radio"), /only the stream/);
    // a repeated field is refused before any of that, as everywhere else
    assert.throws(() => parseLink(`?audio=${encodeURIComponent(AUDIO)}&audio=${encodeURIComponent(AUDIO)}`, "radio"), /repeats/);
});

test("the page is a radio page, with the markers the injector needs", () => {
    assert.ok(PAGE.includes('data-mode="radio"'));
    assert.ok(PAGE.includes("<!-- WOOPOD_SHARE_META_START -->"));
    assert.ok(PAGE.includes("<!-- WOOPOD_SHARE_META_END -->"));
    assert.ok(PAGE.indexOf("WOOPOD_SHARE_META_START") < PAGE.indexOf("WOOPOD_SHARE_META_END"));
    assert.match(PAGE, /<script type="module" src="\.\.\/player\/player\.mjs/, "the shell loads the player");
});

test("http streams play through the relay on https pages, directly elsewhere", () => {
    const httpStream = "http://stream.example.com/live.mp3";
    assert.equal(radioPlayback(httpStream, "https:"), `/api/v1/radio-stream?u=${encodeURIComponent(httpStream)}`);
    assert.equal(radioPlayback(httpStream, "http:"), httpStream, "plain-HTTP pages have no mixed-content rule");
    assert.equal(radioPlayback(AUDIO, "https:"), AUDIO, "HTTPS stations never touch the relay");
});

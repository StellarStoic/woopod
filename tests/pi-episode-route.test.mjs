// The Podcast Index byguid route is a route, not only an internal call.
//
// `episodeByGuidEndpoint` was added for the oversized-feed fallback inside /api/v1/clip, but the router
// that dispatches `/api/v1/pi/…` listed only search, categories and show — so the app asking for the same
// episode by GUID got GitHub Pages' 404 instead of an answer. These tests hold the route open.

import test from "node:test";
import assert from "node:assert/strict";

import { handleApi } from "../server/api.mjs";

const ENV = { PI_API_KEY: "test-key-not-a-real-one", PI_API_SECRET: "test-secret-not-a-real-one" };
const GUID = "4ee0937d-a97b-414c-a067-221e573226ca";
const PI_EPISODE = {
    status: "true",
    episode: {
        id: 42,
        title: "  An   episode  ",
        description: "What happens in it.",
        link: "https://example.com/e42",
        guid: GUID,
        datePublished: 1762990000,
        enclosureUrl: "https://cdn.example.com/e42.mp3",
        enclosureType: "audio/mpeg",
        enclosureLength: 1234,
        duration: 1800,
        episode: 42,
        feedId: 920666,
        feedTitle: "A Test Show",
        feedUrl: "https://example.com/feed.xml",
        feedImage: "https://example.com/art.jpg",
        image: "https://example.com/e42.jpg",
    },
};

const fakeFetch = () => {
    const calls = [];
    const impl = async (url, init = {}) => {
        calls.push(String(url));
        return new Response(JSON.stringify(PI_EPISODE), { status: 200, headers: { "content-type": "application/json" } });
    };
    impl.calls = calls;
    return impl;
};

test("GET /api/v1/pi/episode?guid=… answers with the episode, through the provider", async () => {
    const fetchImpl = fakeFetch();
    const response = await handleApi(new Request(`https://woopod.com/api/v1/pi/episode?guid=${GUID}`), { env: ENV, fetchImpl });
    assert.ok(response, "the route must answer rather than fall through to the static site");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
    const body = await response.json();
    assert.equal(body.episode.guid, GUID);
    assert.equal(body.episode.audioUrl, "https://cdn.example.com/e42.mp3");
    assert.equal(fetchImpl.calls[0].includes("episodes/byguid"), true, "it must ask the byguid endpoint, not search");
});

test("the same route refuses what it cannot answer, and never pretends", async () => {
    // no credentials: a 503 that says so, not an empty 200
    const unconfigured = await handleApi(new Request(`https://woopod.com/api/v1/pi/episode?guid=${GUID}`), { env: {}, fetchImpl: fakeFetch() });
    assert.equal(unconfigured.status, 503);
    assert.equal((await unconfigured.json()).error.code, "not_configured");

    // a missing guid is a 400 from our code, before the provider is touched
    const fetchImpl = fakeFetch();
    const missing = await handleApi(new Request("https://woopod.com/api/v1/pi/episode"), { env: ENV, fetchImpl });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, "guid_missing");
    assert.equal(fetchImpl.calls.length, 0);

    // GET and HEAD only
    const post = await handleApi(new Request(`https://woopod.com/api/v1/pi/episode?guid=${GUID}`, { method: "POST" }), { env: ENV, fetchImpl });
    assert.equal(post.status, 405);
    const head = await handleApi(new Request(`https://woopod.com/api/v1/pi/episode?guid=${GUID}`, { method: "HEAD" }), { env: ENV, fetchImpl });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
});

test("the other pi routes still dispatch to their own handlers", async () => {
    const fetchImpl = fakeFetch();
    // search must not be answered by the episode handler
    const search = await handleApi(new Request("https://woopod.com/api/v1/pi/search?q=anything"), { env: ENV, fetchImpl });
    assert.equal(search.status, 200);
    const asked = fetchImpl.calls.join(" ");
    assert.equal(/episodes\/byguid/.test(asked), false, "search must not reach the episode endpoint");

    // an address that is not one of ours is still left alone
    assert.equal(await handleApi(new Request("https://woopod.com/api/v1/pi/unknown")), null);
    assert.equal(await handleApi(new Request("https://woopod.com/api/v1/pie")), null);
});

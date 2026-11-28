// The Podcast Index byguid route is a route, not only an internal call.
//
// `episodeByGuidEndpoint` was added for the oversized-feed fallback inside /api/v1/clip, but the router
// that dispatches `/api/v1/pi/…` listed only search, categories and show — so the app asking for the same
// episode by GUID got GitHub Pages' 404 instead of an answer. These tests hold the route open.

import test from "node:test";
import assert from "node:assert/strict";

import { handleApi } from "../server/api.mjs";
import { episodeByGuidEndpoint, feedIdByUrl } from "../server/podcastindex.mjs";

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

test("the provider wants the feed id beside the guid, so this asks for it", async () => {
    // what the real provider does: a guid alone is a rejection, the pair is an answer
    const calls = [];
    const impl = async url => {
        calls.push(String(url));
        const address = new URL(String(url));
        if (address.pathname.endsWith("/podcasts/byfeedurl")) {
            assert.equal(address.searchParams.get("url"), "https://example.com/feed.xml");
            return new Response(JSON.stringify({ feed: { id: 920666 } }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (address.pathname.endsWith("/episodes/byguid")) {
            if (address.searchParams.get("feedid") !== "920666") {
                return new Response(JSON.stringify({ status: "false", error: "feedid required" }), { status: 400 });
            }
            assert.equal(address.searchParams.get("guid"), GUID);
            return new Response(JSON.stringify(PI_EPISODE), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("{}", { status: 404 });
    };

    const feedId = await feedIdByUrl("https://example.com/feed.xml", { env: ENV, fetchImpl: impl });
    assert.equal(feedId, 920666);

    const alone = await episodeByGuidEndpoint(new URLSearchParams({ guid: GUID }), { env: ENV, fetchImpl: impl });
    assert.equal(alone.status, 502, "a guid alone is the provider's rejection, reported as a provider failure");

    const paired = await episodeByGuidEndpoint(new URLSearchParams({ guid: GUID, feedid: String(feedId) }), { env: ENV, fetchImpl: impl });
    assert.equal(paired.status, 200);
    assert.equal((await paired.json()).episode.guid, GUID);

    // a feed the provider does not know, and a refusal that must not become an id
    const unknown = await feedIdByUrl("https://example.com/nothing.xml", { env: ENV, fetchImpl: async () => new Response("{}", { status: 404 }) });
    assert.equal(unknown, null);
    assert.equal(await feedIdByUrl("http://insecure.example.com/f.xml", { env: ENV, fetchImpl: impl }), null, "publicAddress still applies");
    assert.equal(await feedIdByUrl("https://example.com/feed.xml", { env: {}, fetchImpl: impl }), null, "no credentials, no call");
});

test("a guid the index does not know is not_found, not an unexpected response", async () => {
    // the provider's real shape for an unknown guid: 200 with status:"false" and no episode object
    const impl = async () => new Response(JSON.stringify({ status: "false", query: { id: "9281234" }, episode: {} }),
        { status: 200, headers: { "content-type": "application/json" } });
    const response = await handleApi(new Request(`https://woopod.com/api/v1/pi/episode?guid=${GUID}&feedid=454880`),
        { env: ENV, fetchImpl: impl });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "not_found");
});

// Podcast Index search: what the endpoint accepts, what it refuses, what it hands back.
//
// The provider is faked here — these tests are about our contract, and a test that needs the real
// API would either hold credentials or go red when someone else's server is busy. The one thing the
// fake cannot prove is the signature being accepted, which is why `authHeaders` is checked against
// Node's own SHA-1 instead.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
    authHeaders, mapShow, mapEpisode, publicAddress, readSearchRequest, providerFailure,
    rateLimit, sha1Hex, searchEndpoint, categoryEndpoint, PI_MAX_LIMIT,
} from "../server/podcastindex.mjs";

const KEY = "test-key-not-a-real-one";
const SECRET = "test-secret-not-a-real-one";
const NOW = 1_763_000_000_000;              // fixed, so the signature is reproducible

const answer = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
});

function fakeFetch(routes) {
    const calls = [];
    const impl = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        for (const [match, respond] of routes) {
            if (String(url).includes(match)) return respond(String(url), init);
        }
        return answer({ status: "false", error: "unexpected address" }, 404);
    };
    impl.calls = calls;
    return impl;
}

const feed = {
    id: 920666,
    podcastGuid: "a1b2c3d4-1111-2222-3333-444455556666",
    title: "  A   Test   Show  ",
    url: "https://example.com/feed.xml",
    link: "https://example.com/",
    description: "x".repeat(600),
    author: "Someone",
    ownerName: "Someone Else",
    artwork: "https://example.com/art.jpg",
    language: "en",
    explicit: 0,
    episodeCount: 512,
    categories: { 9: "Comedy", 11: "Tech" },
    lastUpdateTime: 1762990000,
    newestItemPubdate: 1762900000,
    itunesId: 12345,
    dead: 0,
};

const episode = {
    id: 5550001,
    title: "An episode",
    guid: "ep-guid-abc",
    feedId: 920666,
    feedTitle: "A Test Show",
    feedUrl: "https://example.com/feed.xml",
    feedImage: "https://example.com/art.jpg",
    enclosureUrl: "https://cdn.example.com/ep1.mp3",
    enclosureType: "audio/mpeg",
    enclosureLength: 12345678,
    duration: 3600,
    datePublished: 1762900000,
    explicit: 0,
    episode: 42,
    season: 3,
    episodeType: "full",
    link: "https://example.com/ep1",
};

test("category browsing uses only the documented category and trending endpoints", async () => {
    const fetchImpl = fakeFetch([
        ["/categories/list", () => answer({ feeds: [{ id: 9, name: "Comedy" }] })],
        ["/podcasts/trending", () => answer({ feeds: [feed] })],
    ]);
    const options = { env: { PI_API_KEY: KEY, PI_API_SECRET: SECRET }, now: NOW, fetchImpl };
    let result = await categoryEndpoint(new URLSearchParams(), options);
    assert.deepEqual((await result.json()).categories, [{ id: 9, name: "Comedy" }]);
    result = await categoryEndpoint(new URLSearchParams("id=9&url=https://evil.test"), options);
    assert.equal((await result.json()).results.shows[0].feedUrl, feed.url);
    const target = new URL(fetchImpl.calls[1].url);
    assert.equal(target.searchParams.get("cat"), "9");
    assert.equal(target.searchParams.has("url"), false);
    assert.equal((await categoryEndpoint(new URLSearchParams("id=9,10"), options)).status, 400);
});

test("the signature is the documented sha1 of key + secret + date", async () => {
    // Node's SHA-1 is the reference; the endpoint's own helper has to agree with it exactly.
    assert.equal(await sha1Hex("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    for (const text of ["", "x", "key+secret+1613713388", "ž-unicode-🙂"]) {
        assert.equal(await sha1Hex(text), createHash("sha1").update(text, "utf8").digest("hex"));
    }

    const date = Math.floor(NOW / 1000);
    const headers = await authHeaders(KEY, SECRET, NOW / 1000);
    assert.equal(headers["X-Auth-Key"], KEY);
    assert.equal(headers["X-Auth-Date"], String(date));
    assert.match(headers["User-Agent"], /^Woopod\//);
    assert.equal(headers.Authorization, createHash("sha1").update(`${KEY}${SECRET}${date}`).digest("hex"));
});

test("only q, limit and type are read; nothing else can be forwarded", () => {
    const ok = readSearchRequest(new URLSearchParams("q=podcast&limit=5&type=both&url=https://evil.test/x&path=/admin"));
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.value, { query: "podcast", type: "both", limit: 5 });
    // whitespace is normalised, not passed on
    assert.equal(readSearchRequest(new URLSearchParams("q=%20%20quiet%20%20part%20")).value.query, "quiet part");
    // the app's word for people search is the provider's episode search
    assert.equal(readSearchRequest(new URLSearchParams("q=x&type=people")).value.type, "episodes");
    assert.equal(readSearchRequest(new URLSearchParams("q=x")).value.limit, 20);
    assert.equal(readSearchRequest(new URLSearchParams("q=x&limit=100")).value.limit, 100);
    // the provider documents up to 1000; this endpoint allows 200, and anything above is clamped
    assert.equal(readSearchRequest(new URLSearchParams("q=x&limit=200")).value.limit, 200);
    // a limit above the ceiling is clamped, and the answer states what was used
    assert.equal(readSearchRequest(new URLSearchParams("q=x&limit=9999")).value.limit, PI_MAX_LIMIT);
});

test("what is refused, and with which code", () => {
    const cases = [
        ["", "query_missing"],
        ["q=%20%20", "query_missing"],
        [`q=${"a".repeat(121)}`, "query_too_long"],
        ["q=bad%00term", "query_invalid"],
        ["q=x&type=feeds", "type_invalid"],
        ["q=x&limit=0", "limit_invalid"],
        ["q=x&limit=2.5", "limit_invalid"],
        ["q=x&limit=abc", "limit_invalid"],
    ];
    for (const [search, code] of cases) {
        const result = readSearchRequest(new URLSearchParams(search));
        assert.equal(result.ok, false, `${search} should be refused`);
        assert.equal(result.error.code, code, search);
    }
});

test("a provider address must not point back inside a network", () => {
    assert.equal(publicAddress("https://example.com/feed.xml"), "https://example.com/feed.xml");
    for (const bad of [
        "http://localhost/feed.xml", "https://box.local/f", "https://printer.internal/f",
        "http://192.168.1.10/f", "http://127.0.0.1:8080/f", "https://[::1]/f",
        "https://example.onion/f", "ftp://example.com/f", "https://example.com:8443/f",
        "https://bare-name/f", "", null, "not a url",
    ]) {
        assert.equal(publicAddress(bad), null, `should refuse ${bad}`);
    }
});

test("a show keeps its identity and its real feed address", () => {
    const mapped = mapShow(feed);
    assert.equal(mapped.title, "A Test Show");
    assert.equal(mapped.feedUrl, "https://example.com/feed.xml");
    assert.equal(mapped.podcastGuid, feed.podcastGuid);
    assert.equal(mapped.feedId, 920666);
    assert.deepEqual(mapped.categories, ["Comedy", "Tech"]);
    assert.equal(mapped.lastUpdate, new Date(1762990000 * 1000).toISOString());
    assert.equal(mapped.episodeCount, 512);
    // the description is trimmed rather than dumped
    assert.ok(mapped.description.length <= 400, `description was ${mapped.description.length}`);
    // a feed whose address is refused keeps what identifies it, loses only the address
    const hostile = mapShow({ ...feed, url: "http://10.0.0.5/feed.xml" });
    assert.equal(hostile.feedUrl, null);
    assert.equal(hostile.podcastGuid, feed.podcastGuid);
});

test("an episode carries the original guid and audio, beside its feed", () => {
    const mapped = mapEpisode(episode);
    assert.equal(mapped.guid, "ep-guid-abc");
    assert.equal(mapped.audioUrl, "https://cdn.example.com/ep1.mp3");
    assert.equal(mapped.feedUrl, "https://example.com/feed.xml");
    assert.equal(mapped.feedId, 920666);
    assert.equal(mapped.episodeNumber, 42);
    assert.equal(mapped.season, 3);
    assert.equal(mapped.duration, 3600);
    assert.equal(mapped.audioLength, 12345678);
    assert.equal(mapEpisode({ ...episode, enclosureUrl: "http://169.254.169.254/latest" }).audioUrl, null);
});

test("the endpoint answers a search, and says what it is not", async () => {
    const fetchImpl = fakeFetch([
        ["search/byterm", () => answer({ status: "true", feeds: [feed], count: 1 })],
    ]);
    const response = await searchEndpoint(new URLSearchParams("q=test"), {
        env: { PI_API_KEY: KEY, PI_API_SECRET: SECRET }, fetchImpl, now: NOW,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.provider, "podcastindex");
    assert.equal(body.counts.shows, 1);
    assert.equal(body.results.shows[0].feedUrl, "https://example.com/feed.xml");
    assert.equal(body.results.episodes, undefined, "an unasked part is absent, not empty");
    assert.equal(body.partial, false);
    // the honest limit travels with the data, not only in the documentation
    assert.match(body.notice, /not a search of every episode description/);
    // the request that went out carried the search and nothing else
    const sent = new URL(fetchImpl.calls[0].url);
    assert.equal(sent.origin + sent.pathname, "https://api.podcastindex.org/api/1.0/search/byterm");
    assert.deepEqual([...sent.searchParams.keys()].sort(), ["max", "q"]);
    assert.equal(sent.searchParams.get("q"), "test");
    // Cloudflare Workers reject redirect:"error" outright — Node accepts it, so this must be asserted
    assert.equal(fetchImpl.calls[0].init.redirect, "manual");
});

test("both parts, and one of them failing, still answers with the half that worked", async () => {
    const fetchImpl = fakeFetch([
        ["search/byterm", () => answer({ status: "true", feeds: [feed] })],
        ["search/byperson", () => answer({ error: "boom" }, 500)],
    ]);
    const response = await searchEndpoint(new URLSearchParams("q=test&type=both"), {
        env: { PI_API_KEY: KEY, PI_API_SECRET: SECRET }, fetchImpl, now: NOW,
    });
    assert.equal(response.status, 200, "a half answer is a 200 with partial: true");
    const body = await response.json();
    assert.equal(body.partial, true);
    assert.equal(body.counts.shows, 1);
    assert.equal(body.errors[0].part, "episodes");
    assert.equal(body.errors[0].code, "provider_unavailable");
});

test("provider failures keep their category and never quote our credentials", async () => {
    const cases = [
        [401, 502, "provider_auth_failed"],
        [403, 502, "provider_auth_failed"],
        [429, 429, "provider_rate_limited"],
        [500, 502, "provider_unavailable"],
        [503, 502, "provider_unavailable"],
    ];
    for (const [upstream, ours, code] of cases) {
        const fetchImpl = fakeFetch([["search/byterm", () => answer({ status: "false" }, upstream)]]);
        const response = await searchEndpoint(new URLSearchParams("q=test"), {
            env: { PI_API_KEY: KEY, PI_API_SECRET: SECRET }, fetchImpl, now: NOW,
        });
        assert.equal(response.status, ours, `${upstream} → ${ours}`);
        const text = await response.text();
        const body = JSON.parse(text);
        assert.equal(body.error.code, code);
        // the one thing that must never travel back
        assert.ok(!text.includes(KEY), "the key leaked into the response");
        assert.ok(!text.includes(SECRET), "the secret leaked into the response");
    }
    // a timeout is its own category, not a generic failure
    const timeout = providerFailure(0, true);
    assert.equal(timeout.category, "provider_timeout");
    assert.equal(timeout.status, 504);
});

test("a redirect is refused rather than followed, and reported as its own category", async () => {
    assert.equal(providerFailure(301, false).category, "provider_redirect");
    assert.equal(providerFailure(302, false).status, 502);
    const fetchImpl = fakeFetch([["search/byterm", () => new Response("", { status: 302, headers: { location: "https://elsewhere.test/" } })]]);
    const response = await searchEndpoint(new URLSearchParams("q=test"), {
        env: { PI_API_KEY: KEY, PI_API_SECRET: SECRET }, fetchImpl, now: NOW,
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "provider_redirect");
});

test("an aborted provider call is reported as a timeout, not as an empty result", async () => {
    const fetchImpl = async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
    };
    const response = await searchEndpoint(new URLSearchParams("q=test"), {
        env: { PI_API_KEY: KEY, PI_API_SECRET: SECRET }, fetchImpl, now: NOW,
    });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, "provider_timeout");
});

test("without secrets the endpoint says so, instead of asking the provider", async () => {
    const fetchImpl = fakeFetch([]);
    const response = await searchEndpoint(new URLSearchParams("q=test"), { env: {}, fetchImpl, now: NOW });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "not_configured");
    assert.equal(fetchImpl.calls.length, 0, "no credentials means no call");
});

test("a caller is rate-limited, and told when to come back", () => {
    const key = "ip-203.0.113.9";
    let last = null;
    for (let index = 0; index < 31; index += 1) {
        last = rateLimit(key, { now: NOW });
    }
    assert.equal(last.allowed, false);
    assert.ok(last.retryAfter >= 1 && last.retryAfter <= 60);
    // a different address is unaffected, and the window expires
    assert.equal(rateLimit("ip-203.0.113.10", { now: NOW }).allowed, true);
    assert.equal(rateLimit(key, { now: NOW + 61_000 }).allowed, true);
});

test("search keeps nothing: no cache headers that would store a query at the edge", async () => {
    const fetchImpl = fakeFetch([["search/byterm", () => answer({ status: "true", feeds: [feed] })]]);
    const response = await searchEndpoint(new URLSearchParams("q=private-question"), {
        env: { PI_API_KEY: KEY, PI_API_SECRET: SECRET }, fetchImpl, now: NOW,
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-woopod-cache"), "off");
});

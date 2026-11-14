// The two same-origin resolvers the browser pages call, checked against what those pages expect.
//
// player.mjs requires `title` and `podcast` and treats a non-OK response as a resolver failure with
// `{error}`; show.mjs requires `title` and an `episodes` array and builds its /p links from
// identitySource + identity. Those are the assertions here.

import test from "node:test";
import assert from "node:assert/strict";

import { clipEndpoint, dateOf, handleApi, originAllowed, showFromFeed, showEndpoint } from "../server/api.mjs";
import { parseFeed, safeFetch } from "../server/resolver.mjs";

const FEED = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
  <title>A Show</title>
  <description>What this podcast is &amp; who makes it.</description>
  <podcast:guid>pg-1</podcast:guid>
  <itunes:image href="https://cdn.example.com/cover.jpg"/>
  <item>
    <title>Episode 42</title>
    <guid>ep-42</guid>
    <pubDate>Sat, 14 Nov 2026 18:30:00 +0100</pubDate>
    <enclosure url="https://cdn.example.com/a.mp3" type="audio/mpeg"/>
    <description><![CDATA[<p>The <b>summary</b></p>]]></description>
    <itunes:episode>42</itunes:episode>
  </item>
  <item>
    <title>Enclosure only</title>
    <enclosure url="https://cdn.example.com/b.mp3" type="audio/mpeg"/>
  </item>
  <item>
    <title>Nothing to open</title>
  </item>
</channel></rss>`;

const impl = async () => ({ body: FEED, finalUrl: "https://feeds.example.com/feed.xml" });
const params = query => new URLSearchParams(query);
const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Show</title>
    <entry><title>Only</title><id>urn:uuid:1</id>
    <link rel="enclosure" href="https://cdn.example.com/only.mp3"/>
    <updated>2026-11-14T19:30:00Z</updated></entry></feed>`;

test("/api/v1/show returns what show.mjs renders", async () => {
    const response = await showEndpoint(params("f=https%3A%2F%2Ffeeds.example.com%2Ffeed.xml"), { fetchImpl: impl });
    assert.equal(response.status, 200);
    const show = await response.json();
    assert.equal(show.title, "A Show");
    assert.match(show.description, /What this podcast is & who makes it/);
    assert.equal(show.artwork, "https://cdn.example.com/cover.jpg");
    assert.equal(show.podcastGuid, "pg-1", "the page needs it to build pg= on every /p link");
    assert.equal(show.feed, "https://feeds.example.com/feed.xml");
    assert.equal(show.episodes.length, 3);
    const [first, second, third] = show.episodes;
    assert.equal(first.identitySource, "eg");
    assert.equal(first.identity, "ep-42");
    assert.equal(first.number, "42");
    assert.equal(first.date, "2026-11-14");
    assert.match(first.description, /The summary/);
    assert.equal(second.identitySource, "eu", "no guid, so the enclosure is the identity");
    assert.equal(third.identitySource, undefined, "nothing to open, and the page says so");
    assert.equal(third.identity, undefined);
});

test("an atom show provides ea identities", async () => {
    const show = showFromFeed(parseFeed(atom), "https://feeds.example.com/atom.xml");
    assert.equal(show.title, "Atom Show");
    assert.equal(show.episodes[0].identitySource, "ea");
    assert.equal(show.episodes[0].identity, "urn:uuid:1");
    assert.equal(show.episodes[0].date, "2026-11-14");
});

test("/api/v1/clip returns the four fields the player requires", async () => {
    const response = await clipEndpoint(
        params("f=https%3A%2F%2Ffeeds.example.com%2Ffeed.xml&eg=ep-42"), { fetchImpl: impl });
    assert.equal(response.status, 200);
    const episode = await response.json();
    assert.equal(episode.title, "Episode 42");
    assert.equal(episode.podcast, "A Show");
    assert.equal(episode.audio, "https://cdn.example.com/a.mp3");
    assert.equal(episode.artwork, "https://cdn.example.com/cover.jpg");
    assert.equal(episode.episodeNumber, "42");
    assert.match(episode.summary, /The summary/);
    assert.equal(episode.feed, "https://feeds.example.com/feed.xml");
});

test("a failure answers {error} with a status, because resolverError() reads that", async () => {
    const cases = [
        ["f=https%3A%2F%2Ffeeds.example.com%2Ffeed.xml", 400],                    // no identity
        ["eg=ep-42", 400],                                                        // no feed
        ["f=https%3A%2F%2Flocalhost%2Ffeed.xml&eg=ep-42", 400],                   // private host
        ["f=http%3A%2F%2Ffeeds.example.com%2Ff.xml&eg=ep-42", 400],               // not https
        ["f=https%3A%2F%2Ffeeds.example.com%2Ffeed.xml&eg=missing", 404],         // not in the feed
    ];
    for (const [query, status] of cases) {
        const response = await clipEndpoint(params(query), { fetchImpl: impl });
        assert.equal(response.status, status, query);
        const body = await response.json();
        assert.equal(typeof body.error, "string", `${query} must explain itself`);
        assert.ok(body.error.length > 8);
    }
});

test("an unreachable feed is a 502 with words a reader can act on", async () => {
    const dead = async () => { throw Object.assign(new Error("x"), { code: "unreachable" }); };
    const response = await clipEndpoint(params("f=https%3A%2F%2Ffeeds.example.com%2Ffeed.xml&eg=ep-42"), { fetchImpl: dead });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /could not be reached/);
});

test("an episode that names no audio is refused rather than played as silence", async () => {
    const audioless = `<rss><channel><title>S</title><item><title>No file</title><guid>g</guid></item></channel></rss>`;
    const response = await clipEndpoint(params("f=https%3A%2F%2Ffeeds.example.com%2Ffeed.xml&eg=g"),
        { fetchImpl: async () => ({ body: audioless, finalUrl: "https://feeds.example.com/f.xml" }) });
    assert.equal(response.status, 422);
});

test("a show with no episodes says so instead of rendering an empty list", async () => {
    const empty = `<rss><channel><title>Empty</title></channel></rss>`;
    const response = await showEndpoint(params("f=https%3A%2F%2Ffeeds.example.com%2Ffeed.xml"),
        { fetchImpl: async () => ({ body: empty, finalUrl: "https://feeds.example.com/f.xml" }) });
    assert.equal(response.status, 422);
});

test("the resolver answers only the site itself", async () => {
    assert.equal(originAllowed(new Request("https://woopod.com/api/v1/show?f=x")), true);
    assert.equal(originAllowed(new Request("https://woopod.com/api/v1/show?f=x",
        { headers: { origin: "https://woopod.com" } })), true);
    assert.equal(originAllowed(new Request("https://woopod.com/api/v1/show?f=x",
        { headers: { origin: "https://not-woopod.example" } })), false);
    const rejected = await handleApi(new Request("https://woopod.com/api/v1/show?f=x",
        { headers: { origin: "https://evil.example" } }));
    assert.equal(rejected.status, 403);
});

test("the route answers only GET and HEAD, and only its own two addresses", async () => {
    const post = await handleApi(new Request("https://woopod.com/api/v1/show?f=x", { method: "POST" }));
    assert.equal(post.status, 405);
    const head = await handleApi(new Request("https://woopod.com/api/v1/clip?f=x", { method: "HEAD" }));
    assert.equal(head.status, 400, "a HEAD still gets the status, without a body");
    assert.equal(await head.text(), "");
    assert.equal(await handleApi(new Request("https://woopod.com/api/v1/admission")), null,
        "not ours to answer here");
    assert.equal(await handleApi(new Request("https://woopod.com/p/")), null);
});

test("a date is an ISO day, or the feed's own words", () => {
    assert.equal(dateOf("Sat, 14 Nov 2026 18:30:00 +0100"), "2026-11-14");
    assert.equal(dateOf("2026-11-14T19:30:00Z"), "2026-11-14");
    assert.equal(dateOf("last Tuesday"), "last Tuesday");
    assert.equal(dateOf(null), null);
});

test("a giant feed cannot make an unbounded answer", () => {
    const items = Array.from({ length: 900 }, (_, index) =>
        `<item><title>Episode ${index}</title><guid>g-${index}</guid>
         <enclosure url="https://cdn.example.com/${index}.mp3"/></item>`).join("");
    const show = showFromFeed(parseFeed(`<rss><channel><title>Big</title>${items}</channel></rss>`), "https://f.example/feed.xml");
    assert.equal(show.episodes.length, 300); assert.equal(show.total, 900); assert.equal(show.nextOffset, 300);
    const second = showFromFeed(parseFeed(`<rss><channel><title>Big</title>${items}</channel></rss>`), "https://f.example/feed.xml", 300);
    assert.equal(second.episodes[0].identity, "g-300"); assert.equal(second.nextOffset, 600);
    const last = showFromFeed(parseFeed(`<rss><channel><title>Big</title>${items}</channel></rss>`), "https://f.example/feed.xml", 600);
    assert.equal(last.episodes.at(-1).identity, "g-899"); assert.equal(last.nextOffset, null);
});

test("show endpoint validates paging offsets", async () => {
    const impl = async () => ({body: `<rss><channel><title>Feed</title><item><title>One</title><guid>g</guid><enclosure url="https://cdn.example/a.mp3"/></item></channel></rss>`, finalUrl:"https://example.org/feed"});
    for (const offset of ["-1", "1.5", "001", "99999999"]) {
        const response = await showEndpoint(new URLSearchParams({f:"https://example.org/feed",offset}), {fetchImpl:impl});
        assert.equal(response.status, 400);
    }
    const end = await showEndpoint(new URLSearchParams({f:"https://example.org/feed",offset:"300"}), {fetchImpl:impl});
    assert.equal(end.status, 200); assert.equal((await end.json()).nextOffset, null);
});

test("feed size ceiling rejects rather than silently truncating", async () => {
    const previous = globalThis.fetch;
    try {
        globalThis.fetch = async () => new Response('12345');
        assert.equal((await safeFetch('https://example.org/feed',{maxBytes:5})).body,'12345');
        await assert.rejects(() => safeFetch('https://example.org/feed',{maxBytes:4}), e => e.code === 'too_large');
    } finally { globalThis.fetch = previous; }
});

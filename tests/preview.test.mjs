// What a crawler is served for woopod.com/p and /c, checked against the real pages this repo ships.
//
// The preview module is the website's own (`player/share-metadata.mjs`); these tests are about the
// route and the resolver around it — the page must still open, the card must not lie, and two clips of
// one episode must never unfurl as the same thing.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handle, kindOf, worker } from "../server/route.mjs";
import { parseFeed, resolveEpisode, targetRefused } from "../server/resolver.mjs";
import { renderShareMetadata, shareMetadata } from "../player/share-metadata.mjs";

const CLIP_PAGE = readFileSync(new URL("../c/index.html", import.meta.url), "utf8");
const EPISODE_PAGE = readFileSync(new URL("../p/index.html", import.meta.url), "utf8");
const ORIGIN = "https://woopod.com";

const note = text => Buffer.from(text, "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const serve = html => () => new Response(html, { status: 200, headers: { "content-type": "text/html" } });

const preview = async (path, { html = CLIP_PAGE, env = {} } = {}) => {
    const response = await handle(new Request(`${ORIGIN}${path}`), { getPage: serve(html), env });
    return { response, body: await response.text() };
};

const metaContent = (html, key) => {
    const match = new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(html);
    return match ? match[1] : null;
};

const countOf = (html, key) =>
    (html.match(new RegExp(`<meta (?:property|name)="${key}"`, "g")) || []).length;

test("the shipped pages carry the markers the injector needs", () => {
    for (const page of [CLIP_PAGE, EPISODE_PAGE]) {
        assert.ok(page.includes("<!-- WOOPOD_SHARE_META_START -->"));
        assert.ok(page.includes("<!-- WOOPOD_SHARE_META_END -->"));
        assert.ok(page.indexOf("WOOPOD_SHARE_META_START") < page.indexOf("WOOPOD_SHARE_META_END"));
    }
});

test("a clip page is served with the generic standing card replaced", async () => {
    const { response, body } = await preview("/c/?f=https%3A%2F%2Ffeeds.example.com%2Ffeed.xml&eg=ep-42");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-woopod-preview"), "fallback", "no feed was reachable");
    // The page ships its own default description; the standing card is replaced, not appended to.
    assert.doesNotMatch(body, /A little room to listen\. Play a shared podcast or clip with Woopod\./);
    assert.equal(countOf(body, "og:title"), 1, "exactly one og:title, not two");
    assert.equal(metaContent(body, "og:title"), "A good listen, shared with Woopod",
        "nothing resolved, so the generic heading is the honest one");
    assert.ok(metaContent(body, "og:image").startsWith("https://woopod.com/"));
});

test("a clip with a note previews the note and its bounds, and never advertises audio", async () => {
    const path = `/c/?f=https%3A%2F%2Ffeeds.example.com%2Ff.xml&eg=ep-42&s=15&e=45&c=${note("tale del je noro dober")}`;
    const { body } = await preview(path);
    const description = metaContent(body, "og:description");
    assert.match(description, /tale del je noro dober/);
    assert.match(description, /0:15–0:45/);
    assert.equal(metaContent(body, "og:audio"), null);
    assert.doesNotMatch(body, /og:audio/);
});

test("a whole episode from a direct link takes its title from the link", async () => {
    const { response, body } = await preview(
        "/p/?audio=https%3A%2F%2Fcdn.example.com%2Fa.mp3&title=Demo%20Episode&podcast=Demo%20Show",
        { html: EPISODE_PAGE });
    assert.equal(response.headers.get("x-woopod-preview"), "resolved");
    assert.equal(metaContent(body, "og:title"), "Demo Episode · Demo Show");
    // The attribute is HTML-escaped, which is correct: & becomes &amp; inside an attribute value.
    assert.equal(metaContent(body, "og:url").replace(/&amp;/g, "&"),
        `${ORIGIN}/p?audio=https%3A%2F%2Fcdn.example.com%2Fa.mp3&title=Demo%20Episode&podcast=Demo%20Show`);
});

test("a resolved feed gives the card the publisher's own words", async () => {
    const feed = `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
        <channel><title>A Show</title><itunes:image href="https://cdn.example.com/cover.jpg"/>
        <item><title>Episode 42</title><guid>ep-42</guid>
        <enclosure url="https://cdn.example.com/a.mp3" type="audio/mpeg"/></item></channel></rss>`;
    const episode = await resolveEpisode(
        new URLSearchParams("f=https%3A%2F%2Ffeeds.example.com%2Ffeed.xml&eg=ep-42"),
        { fetchImpl: async () => ({ body: feed, finalUrl: "https://feeds.example.com/feed.xml" }) });
    assert.equal(episode.title, "Episode 42");
    assert.equal(episode.podcast, "A Show");
    assert.equal(episode.artwork, "https://cdn.example.com/cover.jpg");

    const metadata = shareMetadata(`${ORIGIN}/p/?f=https%3A%2F%2Ffeeds.example.com%2Ffeed.xml&eg=ep-42`, episode);
    assert.equal(metadata.title, "Episode 42 · A Show");
    assert.equal(metadata.image, "https://cdn.example.com/cover.jpg");
    const html = renderShareMetadata(EPISODE_PAGE, metadata);
    assert.equal(metaContent(html, "og:image"), "https://cdn.example.com/cover.jpg");
});

test("a publisher's quote cannot break out of the attribute", () => {
    const metadata = shareMetadata(`${ORIGIN}/p/?audio=https%3A%2F%2Fcdn.example.com%2Fa.mp3`,
        { title: 'He said "listen" & <ran>' });
    const html = renderShareMetadata(EPISODE_PAGE, metadata);
    assert.match(metaContent(html, "og:title"), /^He said &quot;listen&quot; &amp; &lt;ran&gt;$/);
});

test("two clips of one episode unfurl as two different things", async () => {
    const base = "/c/?f=https%3A%2F%2Ffeeds.example.com%2Ff.xml&eg=ep-42";
    const first = await preview(`${base}&s=10&e=20&c=${note("prvi")}`);
    const second = await preview(`${base}&s=30&e=40&c=${note("drugi")}`);
    assert.notEqual(metaContent(first.body, "og:url"), metaContent(second.body, "og:url"));
    assert.notEqual(metaContent(first.body, "og:description"), metaContent(second.body, "og:description"));
});

test("the player still opens when nothing can be resolved", async () => {
    for (const path of [
        "/c/?f=https%3A%2F%2Flocalhost%2Ff.xml&eg=a",
        "/p/?audio=http%3A%2F%2Fcdn.example.com%2Fa.mp3",
        "/p/?f=https%3A%2F%2Ffeeds.example.com%2Ff.xml&eg=a&pg=wrong-podcast",
        "/p/",
        "/c/?eg=a&eg=b",
    ]) {
        const { response, body } = await preview(path);
        assert.equal(response.status, 200, path);
        assert.ok(body.includes("WOOPOD_SHARE_META_START"), `${path} lost the page`);
        assert.equal(countOf(body, "og:title"), 1, `${path} duplicated og:title`);
    }
});

test("a page without markers is served untouched rather than broken", async () => {
    const bare = "<!doctype html><html><head><title>t</title></head><body>player</body></html>";
    const { response, body } = await preview("/c/?audio=https%3A%2F%2Fcdn.example.com%2Fa.mp3", { html: bare });
    assert.equal(response.status, 200);
    assert.equal(body, bare);
    assert.equal(response.headers.get("x-woopod-preview"), "resolved");
});

test("an unpublished page says so instead of pretending", async () => {
    const response = await handle(new Request(`${ORIGIN}/p/?audio=https%3A%2F%2Fcdn.example.com%2Fa.mp3`),
        { getPage: () => new Response("nope", { status: 404 }) });
    assert.equal(response.status, 404);
});

test("HEAD carries the preview without the body", async () => {
    const response = await handle(new Request(`${ORIGIN}/c/?audio=https%3A%2F%2Fcdn.example.com%2Fa.mp3`, { method: "HEAD" }),
        { getPage: serve(CLIP_PAGE) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
    assert.equal(response.headers.get("x-woopod-preview"), "resolved");
});

test("other addresses are not ours", async () => {
    assert.equal(kindOf("/"), null);
    assert.equal(kindOf("/show/"), "show");
    assert.equal(kindOf("/player/player.mjs"), null);
    const rejected = await handle(new Request(`${ORIGIN}/p/`, { method: "POST" }), { getPage: serve(EPISODE_PAGE) });
    assert.equal(rejected.status, 405);
});

test("the resolver will not be pointed inside the network", () => {
    for (const bad of ["http://feeds.example.com/f.xml", "https://localhost/f.xml", "https://127.0.0.1/f.xml",
                       "https://10.1.2.3/f.xml", "https://192.168.0.1/f.xml", "https://172.16.0.1/f.xml",
                       "https://user:pass@feeds.example.com/f.xml", "https://feeds.example.com:8443/f.xml",
                       "https://feed.onion/f.xml", "https://myhost/f.xml"]) {
        assert.ok(targetRefused(bad), `${bad} should be refused`);
    }
    assert.equal(targetRefused("https://feeds.example.com/feed.xml"), null);
});

test("identity precedence is the app's, and a wrong podcast claims nothing", async () => {
    const feed = `<rss><channel><title>S</title><podcast:guid>pg-1</podcast:guid>
        <item><title>By guid</title><guid>g-1</guid><enclosure url="https://cdn.example.com/1.mp3"/></item>
        <item><title>By enclosure</title><guid>g-2</guid><enclosure url="https://cdn.example.com/2.mp3"/></item>
        </channel></rss>`;
    const impl = async () => ({ body: feed, finalUrl: "https://feeds.example.com/f.xml" });
    const byGuid = await resolveEpisode(new URLSearchParams("f=https%3A%2F%2Ffeeds.example.com%2Ff.xml&eg=g-1&eu=https%3A%2F%2Fcdn.example.com%2F2.mp3"), { fetchImpl: impl });
    assert.equal(byGuid, null);
    const byEnclosure = await resolveEpisode(new URLSearchParams("f=https%3A%2F%2Ffeeds.example.com%2Ff.xml&eu=https%3A%2F%2Fcdn.example.com%2F2.mp3"), { fetchImpl: impl });
    assert.equal(byEnclosure, null);
    assert.equal(await resolveEpisode(new URLSearchParams("f=https%3A%2F%2Ffeeds.example.com%2Ff.xml&eg=g-1&pg=pg-2"), { fetchImpl: impl }), null);
    assert.equal((await resolveEpisode(new URLSearchParams("f=https%3A%2F%2Ffeeds.example.com%2Ff.xml&eg=g-1&pg=pg-1"), { fetchImpl: impl })).title, "By guid");
});

test("an atom entry is found by id and by its link rel=enclosure", async () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Show</title>
        <entry><title>Only</title><id>urn:uuid:1</id>
        <link rel="enclosure" href="https://cdn.example.com/only.mp3"/></entry></feed>`;
    const impl = async () => ({ body: atom, finalUrl: "https://feeds.example.com/f.xml" });
    assert.equal((await resolveEpisode(new URLSearchParams("f=https%3A%2F%2Ffeeds.example.com%2Ff.xml&ea=urn%3Auuid%3A1"), {fetchImpl:impl})).title, "Only");
    assert.equal(await resolveEpisode(new URLSearchParams("f=https%3A%2F%2Ffeeds.example.com%2Ff.xml&eu=https%3A%2F%2Fcdn.example.com%2Fonly.mp3"), {fetchImpl:impl}), null);
    assert.equal(parseFeed(atom).channelTitle, "Atom Show");
});

test("a DOCTYPE cannot be used to expand anything", () => {
    const hostile = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
        <rss><channel><title>&xxe;</title><item><title>&xxe;</title><guid>g</guid></item></channel></rss>`;
    assert.doesNotMatch(String(parseFeed(hostile).items[0].title), /root:/);
});

test("the worker entry answers the same way in front of a static origin", async () => {
    const app = worker({ ORIGIN: "https://static.example.com/" });
    const answered = await app.fetch(new Request(`${ORIGIN}/c/?audio=https%3A%2F%2Fcdn.example.com%2Fa.mp3`));
    // The stub origin is unreachable here, so the honest answer is a 404 — not a fabricated card.
    assert.equal(answered.status, 404);
});

test("podcast cards use publisher title, image and the show URL", async () => {
    const {shareMetadata} = await import("../player/share-metadata.mjs");
    const data = shareMetadata(`${ORIGIN}/show?f=https%3A%2F%2Fexample.org%2Ffeed`, {title:"A show",description:"Its description",artwork:"https://example.org/cover.jpg"});
    assert.equal(data.title, "A show"); assert.equal(data.description, "Its description");
    assert.equal(data.image, "https://example.org/cover.jpg"); assert.ok(data.url.startsWith(`${ORIGIN}/show?`));
});

test("show route renders publisher metadata and falls back when unavailable", async () => {
    const page = (await import('node:fs/promises')).readFile(new URL('../show/index.html', import.meta.url), 'utf8');
    const getPage = serve(await page);
    const url = `${ORIGIN}/show?f=https%3A%2F%2Ffeeds.example.com%2Ffeed`;
    const response = await handle(new Request(url), {getPage, resolveShow:async()=>Response.json({title:'The Show',description:'Interesting & thoughtful',artwork:'https://cdn.example.com/a.jpg'})});
    const html = await response.text();
    assert.match(html, /property="og:title" content="The Show"/);
    assert.match(html, /Interesting &amp; thoughtful/);
    const fallback = await handle(new Request(url), {getPage, resolveShow:async()=>new Response('',{status:502})});
    assert.equal(fallback.status,200);
});

test("publisher identities preserve spaces and XML character references", async () => {
    const feed = `<rss><channel><title>S</title><podcast:guid> P&amp;G </podcast:guid><item><title>E</title><guid> a&amp;b </guid><enclosure url="https://cdn.example.com/a.mp3"/></item></channel></rss>`;
    const impl = async()=>({body:feed,finalUrl:'https://example.org/feed'});
    const q = new URLSearchParams({f:'https://example.org/feed',eg:' a&b ',pg:' P&G '});
    assert.equal((await resolveEpisode(q,{fetchImpl:impl})).title,'E');
    q.set('eg','a&b'); assert.equal(await resolveEpisode(q,{fetchImpl:impl}),null);
});

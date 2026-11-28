// Resolve a shared locator to an episode — the resolver the share-metadata module expects the host
// to supply. `player/share-metadata.mjs` never fetches anything, so every risk of reading a stranger's
// URL lives here and nothing else touches the network on a preview request.
//
// Everything is bounded: HTTPS only, no credentials, no unusual port, no private or numeric address,
// at most three redirects with each hop re-checked, a byte cap, a timeout, and a parser that cannot be
// talked into expanding an entity.

import { episodeByGuidEndpoint, feedIdByUrl, PI_TIMEOUT_MS } from "./podcastindex.mjs";

const FEED_MAX_BYTES = 8_000_000;
const FEED_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
const QUERY_MAX_BYTES = 2048;          // the same bound Android applies

const PRIVATE_HOST = /^(?:localhost|.*\.(?:localhost|local|internal|home|lan)|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/i;

/** Why this address may not be read, or null when it may. */
export function targetRefused(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return "not an address";
    }
    if (url.protocol !== "https:") return "only https is read";
    if (url.username || url.password) return "an address carrying a username";
    if (url.port && url.port !== "443") return "only the standard https port";
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!host.includes(".")) return "not a public hostname";
    if (PRIVATE_HOST.test(host)) return "a private address";
    if (/^\d+(?:\.\d+){1,3}$/.test(host) || host.startsWith("[")) return "a numeric address";
    if (/\.(?:onion|i2p)$/i.test(host)) return "only clear-web addresses are read";
    return null;
}

async function readCapped(response, maxBytes) {
    const reader = response.body?.getReader();
    if (!reader) {
        const buffer = new Uint8Array(await response.arrayBuffer());
        if (buffer.byteLength > maxBytes) throw Object.assign(new Error("feed too large"), { code: "too_large" });
        return new TextDecoder().decode(buffer);
    }
    const chunks = []; let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) throw Object.assign(new Error("feed too large"), { code: "too_large" });
            chunks.push(value);
        }
    } finally { try { await reader.cancel(); } catch {} }
    const joined = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(joined);
}

/** HTTPS fetch with every hop revalidated. Throws a named error rather than returning something odd. */
export async function safeFetch(rawUrl, { maxBytes = FEED_MAX_BYTES, timeoutMs = FEED_TIMEOUT_MS } = {}) {
    let url = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const refused = targetRefused(url);
        if (refused) throw Object.assign(new Error(refused), { code: "forbidden_target" });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
            response = await fetch(url, {
                redirect: "manual",
                signal: controller.signal,
                headers: {
                    "user-agent": "woopod share preview (+https://woopod.com)",
                    accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
                },
            });
        } catch {
            clearTimeout(timer);
            throw Object.assign(new Error("the feed could not be reached"), { code: "unreachable" });
        }
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) { clearTimeout(timer); throw Object.assign(new Error("a redirect with no target"), { code: "bad_redirect" }); }
            clearTimeout(timer);
            url = new URL(location, url).toString();     // the next pass revalidates this hop
            continue;
        }
        if (!response.ok) { clearTimeout(timer); throw Object.assign(new Error(`HTTP ${response.status}`), { code: "bad_status" }); }
        try { return { body: await readCapped(response, maxBytes), finalUrl: url }; }
        catch (error) { if (error?.code === "too_large") throw error; throw Object.assign(new Error("the feed could not be reached"), {code:"unreachable"}); }
        finally { clearTimeout(timer); }
    }
    throw Object.assign(new Error("too many redirects"), { code: "bad_redirect" });
}

function tagText(fragment, name) {
    const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(fragment);
    if (!match) return null;
    return match[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
}

// XML character references are decoded exactly once, here and nowhere else.
//
// A tag's text and an attribute's value are both XML values, and both arrive escaped: an artwork or
// audio address in a feed is written `…?a=1&amp;b=2`. Decoding only the text leaves a doubled escape
// once the value is escaped again for HTML (`&amp;amp;`), which is a URL that resolves to nothing.
function decodeEntities(value) {
    return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (entity, name) => {
        if (name[0] === '#') {
            const num = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
            return Number.isInteger(num) && num > 0 && num <= 0x10ffff && !(num >= 0xd800 && num <= 0xdfff)
                ? String.fromCodePoint(num) : entity;
        }
        return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name.toLowerCase()] || entity;
    });
}

// Publisher identifiers are opaque: preserve whitespace and decode character references once.
function identityText(fragment, name) {
    const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(fragment);
    if (!match) return null;
    const value = match[1];
    const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value);
    if (cdata) return cdata[1];
    return decodeEntities(value);
}

function attribute(fragment, tag, attributeName) {
    const match = new RegExp(`<${tag}\\b[^>]*\\b${attributeName}\\s*=\\s*["']([^"']*)["']`, "i").exec(fragment);
    return match ? decodeEntities(match[1]).trim() : null;
}

/**
 * The feed's items, from a parser that cannot be made to resolve anything.
 *
 * A DOCTYPE is dropped outright and the document is walked with regular expressions, so the classic
 * external-entity trick has nowhere to land.
 */
export function parseFeed(xml) {
    const document = String(xml || "").replace(/<!DOCTYPE[^>[]*(?:\[[\s\S]*?])?>/gi, "");
    const channel = document.split(/<item\b/i)[0].split(/<entry\b/i)[0];
    const channelTitle = tagText(channel, "title") || null;
    const channelImage = attribute(channel, "itunes:image", "href") || tagText(channel, "url") || null;
    const podcastGuid = identityText(channel, "podcast:guid") || null;
    const channelDescription = tagText(channel, "description")
        || tagText(channel, "summary") || tagText(channel, "subtitle") || null;

    const items = [];
    const pattern = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let match;
    while ((match = pattern.exec(document)) !== null) {
        const body = match[2];
        const enclosureTag = /<enclosure\b[^>]*>/i.exec(body)?.[0]
            || /<media:content\b[^>]*>/i.exec(body)?.[0]
            || "";
        // Atom has no <enclosure>: the file is a <link rel="enclosure" href="…">.
        const atomEnclosure = (body.match(/<link\b[^>]*>/gi) || [])
            .find(tag => /rel\s*=\s*["']?enclosure/i.test(tag));
        items.push({
            title: tagText(body, "title"),
            guid: identityText(body, "guid"),
            atomId: identityText(body, "id"),
            enclosure: attribute(enclosureTag, "enclosure", "url")
                || attribute(enclosureTag, "media:content", "url")
                || (atomEnclosure ? attribute(atomEnclosure, "link", "href") : null),
            summary: tagText(body, "description") || tagText(body, "summary") || tagText(body, "content"),
            image: attribute(body, "itunes:image", "href"),
            episodeNumber: tagText(body, "itunes:episode"),
            date: tagText(body, "pubDate") || tagText(body, "published") || tagText(body, "updated"),
        });
    }
    return { channelTitle, channelImage, channelDescription, podcastGuid, items };
}

const plain = value => String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** Is the query the app sent one this server is willing to read? */
export function queryUsable(searchParams) {
    const keys = [...searchParams.keys()];
    if (keys.some(key => searchParams.getAll(key).length !== 1)) return false;
    const bytes = new TextEncoder().encode([...searchParams.entries()]
        .map(([key, value]) => `${key}=${value}`).join("&")).length;
    return bytes <= QUERY_MAX_BYTES;
}

/**
 * The episode a locator names, or null.
 *
 * Kept separate from `resolveEpisode` so the API can tell "this feed cannot be read" (502) from "this
 * feed does not contain that episode" (404): the difference is invisible to a share card, but not to a
 * reader looking at the player.
 */
export function matchEpisode(parsed, finalUrl, { guid, atomId, enclosure, claimedPodcast } = {}) {
    if (claimedPodcast && claimedPodcast !== parsed.podcastGuid) return null;
    if ([guid, atomId, enclosure].filter(Boolean).length !== 1) return null;
    const matches = parsed.items.filter(item => guid ? item.guid === guid : atomId ? item.atomId === atomId :
        !item.guid && !item.atomId && item.enclosure === enclosure);
    if (matches.length !== 1) return null;
    const match = matches[0];
    return {
        title: plain(match.title) || null,
        podcast: plain(parsed.channelTitle) || null,
        artwork: match.image || parsed.channelImage || null,
        audio: match.enclosure || null,
        summary: match.summary ? plain(match.summary) : null,
        episodeNumber: match.episodeNumber || null,
        feed: finalUrl,
    };
}

/**
 * The episode a locator points at, in the shape `shareMetadata()` reads: {title, podcast, artwork}.
 *
 * Identity precedence is the app's: a publisher's RSS guid, then an Atom id, then the enclosure as the
 * last resort. A claimed podcast guid (`pg`) must match, because the right episode number in the wrong
 * podcast is still the wrong episode.
 */
export async function resolveEpisode(searchParams, { fetchImpl = safeFetch, env = {} } = {}) {
    if (!queryUsable(searchParams)) return null;

    const audio = searchParams.get("audio");
    if (audio) {
        if (targetRefused(audio)) return null;
        return {
            title: plain(searchParams.get("title")) || null,
            podcast: plain(searchParams.get("podcast")) || null,
            artwork: null,
            audio,
            feed: null,
        };
    }

    const feed = searchParams.get("f");
    const guid = searchParams.get("eg");
    const atomId = searchParams.get("ea");
    const enclosure = searchParams.get("eu");
    const claimedPodcast = searchParams.get("pg");
    if (!feed || (!guid && !atomId && !enclosure)) return null;
    if (targetRefused(feed)) return null;

    let parsed;
    let finalUrl;
    try {
        const answer = await fetchImpl(feed);
        parsed = parseFeed(answer.body);
        finalUrl = answer.finalUrl;
    } catch (error) {
        if (error?.code === "too_large" && guid) {
            const fromIndex = await resolveByPodcastIndex(guid, feed, { env, fetchImpl });
            if (fromIndex) return fromIndex;
        }
        return null;
    }
    const match = matchEpisode(parsed, finalUrl, { guid, atomId, enclosure, claimedPodcast });
    if (match) return match;
    if (guid) {
        const fromIndex = await resolveByPodcastIndex(guid, feed, { env, fetchImpl });
        if (fromIndex) return fromIndex;
    }
    return null;
}

async function resolveByPodcastIndex(guid, requestedFeed, { env, fetchImpl }) {
    if (!env.PI_API_KEY || !env.PI_API_SECRET) return null;
    let response = await episodeByGuidEndpoint(new URLSearchParams({ guid }), { env, fetchImpl, timeoutMs: PI_TIMEOUT_MS });
    if (!response.ok && requestedFeed) {
        const feedId = await feedIdByUrl(requestedFeed, { env, fetchImpl, timeoutMs: PI_TIMEOUT_MS });
        if (feedId) {
            const retry = await episodeByGuidEndpoint(new URLSearchParams({ guid, feedid: String(feedId) }), { env, fetchImpl, timeoutMs: PI_TIMEOUT_MS });
            if (retry.ok) response = retry;
        }
    }
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const mapped = payload?.episode;
    if (!mapped) return null;
    // Reject a result whose feed does not match the requested feed, so a GUID collision cannot
    // swap in an episode from a different show.
    if (mapped.feedUrl && mapped.feedUrl !== requestedFeed) return null;
    return {
        title: mapped.title || null,
        podcast: mapped.feedTitle || null,
        artwork: mapped.artwork || null,
        audio: mapped.audioUrl || null,
        summary: mapped.description || null,
        episodeNumber: mapped.episodeNumber || null,
        feed: mapped.feedUrl || null,
    };
}

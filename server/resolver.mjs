// Resolve a shared locator to an episode — the resolver the share-metadata module expects the host
// to supply. `player/share-metadata.mjs` never fetches anything, so every risk of reading a stranger's
// URL lives here and nothing else touches the network on a preview request.
//
// Everything is bounded: HTTPS only, no credentials, no unusual port, no private or numeric address,
// at most three redirects with each hop re-checked, a byte cap, a timeout, and a parser that cannot be
// talked into expanding an entity.

const FEED_MAX_BYTES = 2_000_000;
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
        return new TextDecoder().decode(buffer.subarray(0, maxBytes));
    }
    const chunks = [];
    let total = 0;
    while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
    }
    try {
        await reader.cancel();
    } catch { /* already finished */ }
    const joined = new Uint8Array(Math.min(total, maxBytes));
    let offset = 0;
    for (const chunk of chunks) {
        if (offset >= joined.length) break;
        const take = Math.min(chunk.byteLength, joined.length - offset);
        joined.set(chunk.subarray(0, take), offset);
        offset += take;
    }
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
            throw Object.assign(new Error("the feed could not be reached"), { code: "unreachable" });
        } finally {
            clearTimeout(timer);
        }
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) throw Object.assign(new Error("a redirect with no target"), { code: "bad_redirect" });
            url = new URL(location, url).toString();     // the next pass revalidates this hop
            continue;
        }
        if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { code: "bad_status" });
        return { body: await readCapped(response, maxBytes), finalUrl: url };
    }
    throw Object.assign(new Error("too many redirects"), { code: "bad_redirect" });
}

function tagText(fragment, name) {
    const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(fragment);
    if (!match) return null;
    return match[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
}

function attribute(fragment, tag, attributeName) {
    const match = new RegExp(`<${tag}\\b[^>]*\\b${attributeName}\\s*=\\s*["']([^"']*)["']`, "i").exec(fragment);
    return match ? match[1].trim() : null;
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
    const podcastGuid = tagText(channel, "podcast:guid") || null;

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
            guid: tagText(body, "guid"),
            atomId: tagText(body, "id"),
            enclosure: attribute(enclosureTag, "enclosure", "url")
                || attribute(enclosureTag, "media:content", "url")
                || (atomEnclosure ? attribute(atomEnclosure, "link", "href") : null),
            summary: tagText(body, "description") || tagText(body, "summary") || tagText(body, "content"),
            image: attribute(body, "itunes:image", "href"),
            episodeNumber: tagText(body, "itunes:episode"),
        });
    }
    return { channelTitle, channelImage, podcastGuid, items };
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
 * The episode a locator points at, in the shape `shareMetadata()` reads: {title, podcast, artwork}.
 *
 * Identity precedence is the app's: a publisher's RSS guid, then an Atom id, then the enclosure as the
 * last resort. A claimed podcast guid (`pg`) must match, because the right episode number in the wrong
 * podcast is still the wrong episode.
 */
export async function resolveEpisode(searchParams, { fetchImpl = safeFetch } = {}) {
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
    } catch {
        return null;
    }
    if (claimedPodcast && parsed.podcastGuid && claimedPodcast !== parsed.podcastGuid) return null;

    const match = parsed.items.find(item => guid && item.guid === guid)
        || parsed.items.find(item => atomId && item.atomId === atomId)
        || parsed.items.find(item => enclosure && item.enclosure === enclosure);
    if (!match) return null;

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

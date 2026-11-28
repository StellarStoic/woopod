// Podcast Index search for the Woopod app, served by the same Worker as the share pages.
//
// Deliberately narrow. The Podcast Index has forty-odd endpoints; this file exposes two of them, one
// query string parameter, and nothing else — no caller-supplied URL, path, header or upstream
// parameter ever reaches the provider. That is the difference between an API and an open proxy, and
// it is why `type`, `q` and `limit` are read by name instead of being forwarded wholesale.
//
// The credentials live in Worker secrets (`PI_API_KEY`, `PI_API_SECRET`). They are read per request,
// used once to sign the call, and never written into a response, an error, a log line or a header we
// hand back. Nothing here stores the query either: caching is off until the provider's terms have
// been read for what may be retained and for how long (see PI_CACHE_SECONDS below).

export const PI_ORIGIN = "https://api.podcastindex.org";
export const PI_PATH_SHOWS = "/api/1.0/search/byterm";
export const PI_PATH_EPISODES = "/api/1.0/search/byperson";
export const PI_USER_AGENT = "Woopod/1.0 (+https://woopod.com)";

export const PI_TIMEOUT_MS = 8000;
export const PI_DEFAULT_LIMIT = 20;
export const PI_MAX_LIMIT = 200;
export const PI_MAX_QUERY = 120;
export const PI_DESCRIPTION_MAX = 400;

// Best-effort per-IP limit. A Worker isolate has its own memory and Cloudflare runs many, so this is
// a cost guard, not a security boundary — the real ceiling is the provider's own quota, which the
// caller is told about rather than silently absorbs.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const buckets = new Map();

const piJson = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
    status,
    headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "access-control-allow-origin": "https://woopod.com",
        ...extra,
    },
});

/**
 * The documented signature: sha1 of key + secret + unix timestamp, lower-case hex.
 * https://podcastindex-org.github.io/docs-api/#overview--authentication-details
 */
export async function sha1Hex(text) {
    const bytes = new TextEncoder().encode(String(text));
    const digest = await crypto.subtle.digest("SHA-1", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function authHeaders(apiKey, apiSecret, unixSeconds) {
    const date = String(Math.floor(unixSeconds));
    return {
        "User-Agent": PI_USER_AGENT,
        "X-Auth-Key": apiKey,
        "X-Auth-Date": date,
        Authorization: await sha1Hex(`${apiKey}${apiSecret}${date}`),
    };
}

/**
 * A feed or audio address that came back from the provider.
 *
 * The index is public and mostly trustworthy, but a result is still stranger-supplied data: a
 * crafted entry must not be able to hand the app a loopback, LAN, mDNS or onion address to fetch.
 */
export function publicAddress(raw) {
    let url;
    try {
        url = new URL(String(raw || ""));
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.port && url.port !== "80" && url.port !== "443") return null;
    const host = url.hostname.toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".localhost")) return null;
    if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".onion")) return null;
    if (host.startsWith("[") || /^[\d.]+$/.test(host) || host.includes(":")) return null;   // no IP literals
    if (!host.includes(".")) return null;                                                   // no bare names
    return url.toString();
}

const piClean = (value, max = PI_DESCRIPTION_MAX) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const iso = seconds => (Number.isFinite(Number(seconds)) && Number(seconds) > 0
    ? new Date(Number(seconds) * 1000).toISOString()
    : null);

/**
 * The provider's feed object, reduced to what a subscriber list needs.
 *
 * `feedUrl` is the actual feed — the app merges by it and by `podcastGuid`. A feed whose address is
 * refused keeps its identity fields but loses the address, so a bad entry cannot poison a merge.
 */
export function mapShow(feed) {
    if (!feed || typeof feed !== "object") return null;
    const feedUrl = publicAddress(feed.url ?? feed.originalUrl);
    const title = piClean(feed.title, 200);
    if (!title) return null;
    return {
        source: "podcastindex",
        feedId: feed.id ?? null,
        podcastGuid: piClean(feed.podcastGuid, 100) || null,
        title,
        siteUrl: publicAddress(feed.link) || null,
        feedUrl,
        artwork: publicAddress(feed.artwork ?? feed.image) || null,
        description: piClean(feed.description),
        author: piClean(feed.author, 200) || null,
        ownerName: piClean(feed.ownerName, 200) || null,
        language: piClean(feed.language, 20) || null,
        explicit: Boolean(feed.explicit),
        episodeCount: Number.isFinite(Number(feed.episodeCount)) ? Number(feed.episodeCount) : null,
        categories: feed.categories && typeof feed.categories === "object"
            ? Object.values(feed.categories).map(value => piClean(value, 60)).filter(Boolean)
            : [],
        lastUpdate: iso(feed.lastUpdateTime),
        newestItem: iso(feed.newestItemPubdate),
        itunesId: feed.itunesId ?? null,
        dead: Boolean(feed.dead),
    };
}

/**
 * `search/byperson` answers with episodes, not people — the provider has no people resource. The
 * mapping keeps the feed's identity beside each episode so the app can place it in a subscription
 * and the guid/enclosure so it can be matched without trusting titles.
 */
export function mapEpisode(item) {
    if (!item || typeof item !== "object") return null;
    const title = piClean(item.title, 300);
    if (!title) return null;
    return {
        source: "podcastindex",
        providerEpisodeId: item.id ?? null,
        guid: piClean(item.guid, 300) || null,
        title,
        feedId: item.feedId ?? null,
        feedTitle: piClean(item.feedTitle, 200) || null,
        feedUrl: publicAddress(item.feedUrl),
        artwork: publicAddress(item.feedImage ?? item.image) || null,
        audioUrl: publicAddress(item.enclosureUrl),
        audioType: piClean(item.enclosureType, 80) || null,
        audioLength: Number.isFinite(Number(item.enclosureLength)) ? Number(item.enclosureLength) : null,
        description: piClean(item.description),
        duration: Number.isFinite(Number(item.duration)) ? Number(item.duration) : null,
        datePublished: iso(item.datePublished),
        explicit: Boolean(item.explicit),
        episodeNumber: item.episode ?? null,
        season: item.season ?? null,
        episodeType: piClean(item.episodeType, 20) || null,
        siteUrl: publicAddress(item.link) || null,
        chaptersUrl: publicAddress(item.chaptersUrl) || null,
        transcriptUrl: publicAddress(item.transcriptUrl) || null,
    };
}

/**
 * Read only the three parameters this endpoint has, and refuse everything else by ignoring it —
 * an unknown parameter is not forwarded, so there is no way to reach an unlisted endpoint through
 * this route.
 */
export function readSearchRequest(searchParams) {
    const raw = searchParams.get("q");
    const query = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!query) {
        return { ok: false, status: 400, error: { code: "query_missing", field: "q", message: "A search needs a q parameter." } };
    }
    if (query.length > PI_MAX_QUERY) {
        return { ok: false, status: 400, error: { code: "query_too_long", field: "q", message: `A search is at most ${PI_MAX_QUERY} characters.` } };
    }
    // Control characters are not a search term, and they exist mostly to confuse downstream tools.
    if (/[\u0000-\u001f\u007f]/.test(query)) {
        return { ok: false, status: 400, error: { code: "query_invalid", field: "q", message: "The query contains characters that cannot be searched for." } };
    }

    const typeRaw = String(searchParams.get("type") ?? "shows").trim().toLowerCase();
    const type = typeRaw === "people" ? "episodes" : typeRaw;   // the app's word for the same call
    if (!["shows", "episodes", "both"].includes(type)) {
        return { ok: false, status: 400, error: { code: "type_invalid", field: "type", message: "type is shows, episodes or both." } };
    }

    const limitRaw = searchParams.get("limit");
    let limit = PI_DEFAULT_LIMIT;
    if (limitRaw !== null && limitRaw !== "") {
        const parsed = Number(limitRaw);
        if (!Number.isInteger(parsed) || parsed < 1) {
            return { ok: false, status: 400, error: { code: "limit_invalid", field: "limit", message: `limit is a whole number from 1 to ${PI_MAX_LIMIT}.` } };
        }
        limit = Math.min(parsed, PI_MAX_LIMIT);   // clamp rather than fail: the answer states the limit used
    }

    return { ok: true, value: { query, type, limit } };
}

export function rateLimit(bucketKey, { now = Date.now(), windowMs = RATE_WINDOW_MS, max = RATE_MAX } = {}) {
    if (buckets.size > 5000) {
        for (const [key, entry] of buckets) if (entry.resetAt <= now) buckets.delete(key);
    }
    const entry = buckets.get(bucketKey);
    if (!entry || entry.resetAt <= now) {
        buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: max - 1, retryAfter: 0 };
    }
    entry.count += 1;
    if (entry.count > max) {
        return { allowed: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    }
    return { allowed: true, remaining: max - entry.count, retryAfter: 0 };
}

/** Provider status → our category. The provider's body is never returned: it can quote the request. */
export function providerFailure(status, aborted) {
    if (aborted) return { category: "provider_timeout", status: 504, message: "The podcast index did not answer in time." };
    if (status === 401 || status === 403) return { category: "provider_auth_failed", status: 502, message: "The podcast index refused our credentials." };
    if (status === 429) return { category: "provider_rate_limited", status: 429, message: "The podcast index is rate-limiting us. Try again shortly." };
    if (status === 400) return { category: "provider_rejected", status: 502, message: "The podcast index rejected the request." };
    if (status >= 300 && status < 400) return { category: "provider_redirect", status: 502, message: "The podcast index redirected the request; it was not followed." };
    if (status >= 500) return { category: "provider_unavailable", status: 502, message: "The podcast index is unavailable." };
    return { category: "provider_error", status: 502, message: "The podcast index answered unexpectedly." };
}

async function callProvider(path, { query, limit, param = null, params = null }, { apiKey, apiSecret, fetchImpl, now, timeoutMs, debug = false }) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
        const address = new URL(`${PI_ORIGIN}${path}`);
        if (query != null) address.searchParams.set(param || (path.endsWith('/trending') ? 'cat' : path.endsWith('/byguid') ? 'guid' : 'q'), query);
        if (limit != null) address.searchParams.set("max", String(limit));
        for (const [key, value] of Object.entries(params || {})) if (value != null) address.searchParams.set(key, String(value));
        const response = await fetchImpl(address.toString(), {
            method: "GET",
            headers: await authHeaders(apiKey, apiSecret, now / 1000),
            signal: controller?.signal,
            // Workers accept only "follow" and "manual": "error" is a Node-only value and throws at
            // the edge. A redirect is not something to follow blindly, so 3xx is checked below.
            redirect: "manual",
        });
        if (!response.ok) {
            const failure = providerFailure(response.status, false);
            return { ok: false, ...failure };
        }
        const payload = await response.json().catch(() => null);
        if (!payload || typeof payload !== "object") {
            const failure = providerFailure(0, false);
            if (debug) failure.detail = `unreadable body, status ${response.status}, type ${response.headers.get("content-type") || "none"}`;
            return { ok: false, ...failure };
        }
        return { ok: true, payload };
    } catch (error) {
        const aborted = error?.name === "AbortError";
        const failure = providerFailure(0, aborted);
        // TEMPORARY diagnostic: what the fetch actually threw, without the URL or any header.
        if (!aborted && debug) failure.detail = `${error?.name || "Error"}: ${String(error?.message || "").slice(0, 160)}`;
        return { ok: false, ...failure };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// Category browsing is deliberately limited to the index's category list and trending feeds.
export async function categoryEndpoint(searchParams, options = {}) {
    const { env = {}, fetchImpl = (...args) => fetch(...args), now = Date.now(), timeoutMs = PI_TIMEOUT_MS, rateKey = null } = options;
    const category = searchParams.get('id');
    if (category !== null && !/^[1-9][0-9]{0,8}$/.test(category)) return piJson({ error: { code: 'category_invalid', message: 'Invalid category.' } }, 400);
    if (!env.PI_API_KEY || !env.PI_API_SECRET) return piJson({ error: { code: 'not_configured', message: 'Podcast Index is not configured.' } }, 503);
    if (rateKey) {
        const verdict = rateLimit(rateKey, { now });
        if (!verdict.allowed) return piJson({ error: { code: 'rate_limited', message: 'Try again shortly.' } }, 429, { 'retry-after': String(verdict.retryAfter) });
    }
    const result = await callProvider(category === null ? '/api/1.0/categories/list' : '/api/1.0/podcasts/trending',
        { query: category, limit: category === null ? null : 200 },
        { apiKey: env.PI_API_KEY, apiSecret: env.PI_API_SECRET, fetchImpl, now, timeoutMs });
    if (!result.ok) return piJson({ error: pickError(result), provider: 'podcastindex' }, result.status || 502);
    const feeds = result.payload.feeds;
    if (!Array.isArray(feeds)) return piJson({ error: { code: 'provider_error', message: 'Unexpected response from Podcast Index.' } }, 502);
    if (category === null) return piJson({ provider: 'podcastindex', categories: feeds.map(item => ({ id: Number(item.id), name: piClean(item.name, 80) })).filter(item => Number.isSafeInteger(item.id) && item.id > 0 && item.name) });
    return piJson({ provider: 'podcastindex', results: { shows: feeds.map(mapShow).filter(Boolean) } });
}

export async function guidEndpoint(searchParams, options = {}) {
    const { env = {}, fetchImpl = (...args) => fetch(...args), now = Date.now(), timeoutMs = PI_TIMEOUT_MS, rateKey = null } = options;
    const guid = searchParams.get('guid') || '';
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(guid)) return piJson({ error: { code: 'guid_invalid', message: 'Invalid podcast GUID.' } }, 400);
    if (!env.PI_API_KEY || !env.PI_API_SECRET) return piJson({ error: { code: 'not_configured', message: 'Podcast Index is not configured.' } }, 503);
    if (rateKey) {
        const verdict = rateLimit(rateKey, { now });
        if (!verdict.allowed) return piJson({ error: { code: 'rate_limited', message: 'Try again shortly.' } }, 429, { 'retry-after': String(verdict.retryAfter) });
    }
    const result = await callProvider('/api/1.0/podcasts/byguid', { query: guid, limit: null },
        { apiKey: env.PI_API_KEY, apiSecret: env.PI_API_SECRET, fetchImpl, now, timeoutMs });
    if (!result.ok) return piJson({ error: pickError(result), provider: 'podcastindex' }, result.status || 502);
    const show = mapShow(result.payload.feed);
    if (!show || !show.feedUrl) return piJson({ error: { code: 'not_found', message: 'Podcast not found.' }, provider: 'podcastindex' }, 404);
    return piJson({ provider: 'podcastindex', results: { shows: [show] } });
}

/**
 * The index's numeric id for a publisher feed URL.
 *
 * Needed because `/episodes/byguid` is answered only when the guid comes with its feed id, and a shared
 * link carries the feed URL, not the id. Returns null for anything the provider does not know — a caller
 * then keeps whatever answer it already had.
 */
export async function feedIdByUrl(feedUrl, options = {}) {
    const { env = {}, fetchImpl = (...args) => fetch(...args), now = Date.now(), timeoutMs = PI_TIMEOUT_MS } = options;
    if (!env.PI_API_KEY || !env.PI_API_SECRET) return null;
    const address = publicAddress(feedUrl);
    if (!address) return null;
    const result = await callProvider('/api/1.0/podcasts/byfeedurl', { query: address, limit: null, param: 'url' },
        { apiKey: env.PI_API_KEY, apiSecret: env.PI_API_SECRET, fetchImpl, now, timeoutMs });
    if (!result.ok) return null;
    const id = Number(result.payload?.feed?.id);
    return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Answer a call to `/podcasts/byfeedurl` with the show object `shareMetadata()` needs.
 *
 * This is a card-only fallback: the show page still refuses to build an episode list from an oversized
 * feed, but a social scraper can still get the publisher's title, description and artwork.
 */
export async function showByFeedUrlEndpoint(feedUrl, options = {}) {
    const { env = {}, fetchImpl = (...args) => fetch(...args), now = Date.now(), timeoutMs = PI_TIMEOUT_MS } = options;
    if (!env.PI_API_KEY || !env.PI_API_SECRET) return null;
    const address = publicAddress(feedUrl);
    if (!address) return null;
    const result = await callProvider('/api/1.0/podcasts/byfeedurl', { query: address, limit: null, param: 'url' },
        { apiKey: env.PI_API_KEY, apiSecret: env.PI_API_SECRET, fetchImpl, now, timeoutMs });
    if (!result.ok) return null;
    const show = mapShow(result.payload?.feed);
    if (!show || !show.feedUrl) return null;
    return { title: show.title, description: show.description, artwork: show.artwork };
}

/**
 * Answer `GET /api/v1/pi/episode?guid=…&feedid=…` — a single episode by its GUID.
 *
 * This is used as a fallback when a publisher feed is too large to fetch and parse in the Worker.
 */
export async function episodeByGuidEndpoint(searchParams, options = {}) {
    const { env = {}, fetchImpl = (...args) => fetch(...args), now = Date.now(), timeoutMs = PI_TIMEOUT_MS, rateKey = null } = options;
    const guid = searchParams.get('guid') || '';
    const feedid = searchParams.get('feedid') || '';
    if (!guid) return piJson({ error: { code: 'guid_missing', message: 'An episode GUID is required.' } }, 400);
    // The provider wants the feed id beside the guid: a guid alone is answered with a rejection, which
    // used to travel back as a bare 502 with nothing to act on.
    const params = /^\d+$/.test(feedid) ? { feedid } : {};
    if (!env.PI_API_KEY || !env.PI_API_SECRET) return piJson({ error: { code: 'not_configured', message: 'Podcast Index is not configured.' } }, 503);
    if (rateKey) {
        const verdict = rateLimit(rateKey, { now });
        if (!verdict.allowed) return piJson({ error: { code: 'rate_limited', message: 'Try again shortly.' } }, 429, { 'retry-after': String(verdict.retryAfter) });
    }
    const result = await callProvider('/api/1.0/episodes/byguid', { query: guid, limit: null, params },
        { apiKey: env.PI_API_KEY, apiSecret: env.PI_API_SECRET, fetchImpl, now, timeoutMs });
    if (!result.ok) return piJson({ error: pickError(result), provider: 'podcastindex' }, result.status || 502);
    const episode = result.payload.episode || (Array.isArray(result.payload.episodes) ? result.payload.episodes[0] : null);
    if (!episode) return piJson({ error: { code: 'not_found', message: 'Episode not found.' }, provider: 'podcastindex' }, 404);
    const mapped = mapEpisode(episode);
    if (!mapped) return piJson({ error: { code: 'provider_error', message: 'Unexpected response from Podcast Index.' }, provider: 'podcastindex' }, 502);
    return piJson({ provider: 'podcastindex', episode: mapped });
}

/**
 * Answer `GET /api/v1/pi/search`.
 *
 * `type=both` runs the two provider calls in parallel; if one fails the other's answer is still
 * returned, marked `partial` with the failure beside it, because a search that half worked is more
 * useful to a listener than an error page.
 */
export async function searchEndpoint(searchParams, options = {}) {
    const {
        env = {},
        fetchImpl = (...args) => fetch(...args),
        now = Date.now(),
        timeoutMs = PI_TIMEOUT_MS,
        rateKey = null,
    } = options;

    const request = readSearchRequest(searchParams);
    if (!request.ok) {
        return piJson({ error: request.error, provider: "podcastindex" }, request.status);
    }
    const { query, type, limit } = request.value;

    const apiKey = env.PI_API_KEY;
    const apiSecret = env.PI_API_SECRET;
    if (!apiKey || !apiSecret) {
        return piJson({
            error: {
                code: "not_configured",
                message: "Podcast Index search is not configured on this deployment.",
            },
            provider: "podcastindex",
        }, 503);
    }

    if (rateKey) {
        const verdict = rateLimit(rateKey, { now });
        if (!verdict.allowed) {
            return piJson({
                error: { code: "rate_limited", message: "Too many searches from this address." },
                retryAfter: verdict.retryAfter,
                provider: "podcastindex",
            }, 429, { "retry-after": String(verdict.retryAfter) });
        }
    }

    const wanted = {
        shows: type === "shows" || type === "both",
        episodes: type === "episodes" || type === "both",
    };
    // `PI_DEBUG=1` on the deployment adds the reason a call failed to the answer. It never carries a
    // URL, a header or a credential — it exists because a Node test cannot reproduce every edge rule.
    const debug = env.PI_DEBUG === "1";
    const calls = {};
    if (wanted.shows) calls.shows = callProvider(PI_PATH_SHOWS, { query, limit }, { apiKey, apiSecret, fetchImpl, now, timeoutMs, debug });
    if (wanted.episodes) calls.episodes = callProvider(PI_PATH_EPISODES, { query, limit }, { apiKey, apiSecret, fetchImpl, now, timeoutMs, debug });

    const settled = {};
    for (const [name, promise] of Object.entries(calls)) settled[name] = await promise;

    const shows = [];
    const episodes = [];
    const errors = [];

    if (settled.shows?.ok) {
        const feeds = Array.isArray(settled.shows.payload.feeds) ? settled.shows.payload.feeds : [];
        for (const feed of feeds) {
            const mapped = mapShow(feed);
            if (mapped) shows.push(mapped);
        }
    } else if (settled.shows) {
        errors.push({ part: "shows", ...pickError(settled.shows) });
    }

    if (settled.episodes?.ok) {
        const items = Array.isArray(settled.episodes.payload.items) ? settled.episodes.payload.items : [];
        for (const item of items) {
            const mapped = mapEpisode(item);
            if (mapped) episodes.push(mapped);
        }
    } else if (settled.episodes) {
        errors.push({ part: "episodes", ...pickError(settled.episodes) });
    }

    if (errors.length && !shows.length && !episodes.length) {
        // Nothing to show: one failure speaks for the request.
        return piJson({
            error: { ...errors[0], provider: "podcastindex" },
            provider: "podcastindex",
            query,
            type,
        }, errors[0].status || 502);
    }

    return piJson({
        provider: "podcastindex",
        query,
        type,
        limit,
        fetchedAt: new Date(now).toISOString(),
        counts: { shows: shows.length, episodes: episodes.length },
        results: { shows: wanted.shows ? shows : undefined, episodes: wanted.episodes ? episodes : undefined },
        partial: errors.length > 0,
        errors,
        notice: "Results are from the Podcast Index catalogue, not a search of every episode description. "
            + "Merge on feedUrl or podcastGuid; episode guid and audioUrl are the provider's originals.",
    }, 200, { "x-woopod-cache": "off" });
}

function pickError(failure) {
    // TEMPORARY: detail is surfaced while diagnosing; it carries no URL, header or credential.
    const picked = { status: failure.status, code: failure.category, message: failure.message };
    if (failure.detail) picked.detail = failure.detail;
    return picked;
}


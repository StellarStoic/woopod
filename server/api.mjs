// Same-origin resolvers for the browser pages: /api/v1/clip and /api/v1/show.
//
// The pages already speak this: `player/player.mjs` asks for one episode, `show/show.mjs` asks for a
// podcast and builds its own /p links from what comes back. Both are same-origin GETs, so this refuses
// a request that arrives from anywhere else — an open resolver would be a free proxy for anyone.
//
// The response shapes are the pages' contract, not a proposal:
//
//   clip  {title, podcast, audio, artwork?, episodeNumber?, summary?, date?, feed?}
//         `title` and `podcast` are required by the player; a failure answers {error} with a status,
//         and `resolverError()` in player/core.mjs shows that text and keeps the feed link on screen.
//
//   show  {title, description?, artwork?, podcastGuid?, feed, episodes:[
//            {title, description?, date?, number?, identitySource:'eg'|'ea'|'eu', identity}]}
//         an item without a usable identity is returned without one, and the page then says that the
//         episode cannot be opened rather than inventing a link.
//
// All feed reading goes through `safeFetch` in resolver.mjs, so the protections are identical to the
// share-card path: https only, no credentials, no unusual port, no private/numeric/.onion host, at most
// three redirects with each hop revalidated, a byte cap, a timeout, and no entity expansion.

import { matchEpisode, parseFeed, queryUsable, safeFetch, targetRefused } from "./resolver.mjs";

export const API_CACHE_SECONDS = 300;
const MAX_EPISODES = 300;
const TEXT_LIMIT = 600;

const SITE_ORIGIN = "https://woopod.com";

const stripMarkup = value => String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const cut = (value, limit = TEXT_LIMIT) => {
    const text = stripMarkup(value);
    const points = Array.from(text);
    return points.length > limit ? points.slice(0, limit - 1).join("") + "…" : text;
};

/** An ISO date, because the page prints whatever it is given. */
export function dateOf(raw) {
    const text = stripMarkup(raw);
    if (!text) return null;
    const parsed = new Date(text);
    if (Number.isNaN(parsed.valueOf())) return text.slice(0, 40);
    return parsed.toISOString().slice(0, 10);
}

/**
 * The show, in the shape show.mjs renders.
 *
 * Identity per episode follows the app: the publisher's RSS `guid` first, then an Atom `id`, then the
 * enclosure. `number` is `itunes:episode` when the feed states one — the page otherwise counts the rows
 * itself, which is honest for a feed that has no numbers.
 */
export function showFromFeed(parsed, finalUrl, offset = 0) {
    const episodes = [];
    for (const item of parsed.items.slice(offset, offset + MAX_EPISODES)) {
        const identity = item.guid
            ? { identitySource: "eg", identity: item.guid }
            : item.atomId
                ? { identitySource: "ea", identity: item.atomId }
                : item.enclosure
                    ? { identitySource: "eu", identity: item.enclosure }
                    : null;
        const episode = {
            title: cut(item.title, 300),
            description: item.summary ? cut(item.summary) : null,
            date: dateOf(item.date),
            number: item.episodeNumber ? stripMarkup(item.episodeNumber).slice(0, 20) : null,
            ...(identity || {}),
        };
        episodes.push(episode);
    }
    return {
        title: cut(parsed.channelTitle, 300) || "Podcast",
        description: parsed.channelDescription ? cut(parsed.channelDescription, 1200) : null,
        artwork: parsed.channelImage || null,
        podcastGuid: parsed.podcastGuid || null,
        feed: finalUrl,
        episodes,
        total: parsed.items.length,
        nextOffset: offset + episodes.length < parsed.items.length ? offset + episodes.length : null,
    };
}

/**
 * Is this request coming from the site itself?
 *
 * A browser sends `Origin` on a cross-origin fetch and usually omits it on a same-origin GET, so a
 * missing `Origin` is allowed and a present one must be ours. The player also sends
 * `referrerPolicy: no-referrer`, which is why the decision cannot rest on `Referer`.
 */
export function originAllowed(request) {
    const origin = request.headers.get("origin");
    if (!origin) return true;
    try {
        const url = new URL(origin);
        return `${url.protocol}//${url.host}` === SITE_ORIGIN;
    } catch {
        return false;
    }
}

const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
    status,
    headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${API_CACHE_SECONDS}`,
        "x-content-type-options": "nosniff",
        ...extraHeaders,
    },
});

const failure = (message, status) => new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
    },
});

function locatorProblem(searchParams, { needsIdentity = false } = {}) {
    if (!queryUsable(searchParams)) return "This link is too long or repeats a value.";
    const feed = searchParams.get("f");
    if (!feed) return "This link needs one podcast feed.";
    const refused = targetRefused(feed);
    if (refused) return `That feed address cannot be read: ${refused}.`;
    if (needsIdentity && ["eg", "ea", "eu"].filter(key => searchParams.get(key)).length !== 1) {
        return "This link needs exactly one episode identity (eg, ea or eu).";
    }
    return null;
}

async function readFeed(searchParams, fetchImpl) {
    const feed = searchParams.get("f");
    let answer;
    try {
        answer = await (fetchImpl || safeFetch)(feed);
    } catch (error) {
        const code = error?.code;
        if (code === "too_large") throw Object.assign(new Error("This feed is too large for the web player. Open the original feed instead."), { status: 422 });
        if (code === "forbidden_target") throw Object.assign(new Error("That feed address cannot be read."), { status: 400 });
        if (code === "unreachable") throw Object.assign(new Error("The podcast feed could not be reached. Try again, or open the feed link."), { status: 502 });
        if (code === "bad_redirect") throw Object.assign(new Error("The podcast feed redirected somewhere unusable."), { status: 502 });
        if (code === "bad_status") throw Object.assign(new Error("The podcast feed answered with an error."), { status: 502 });
        throw Object.assign(new Error("The podcast feed could not be read."), { status: 502 });
    }
    return { body: answer.body, finalUrl: answer.finalUrl, parsed: parseFeed(answer.body) };
}

/** GET /api/v1/show?f=… — the podcast and its episodes. */
export async function showEndpoint(searchParams, { fetchImpl } = {}) {
    const problem = locatorProblem(searchParams);
    if (problem) return failure(problem, 400);
    const rawOffset = searchParams.get("offset");
    if (rawOffset !== null && (!/^(?:0|[1-9][0-9]{0,6})$/.test(rawOffset))) return failure("Invalid episode offset.", 400);
    const offset = rawOffset === null ? 0 : Number(rawOffset);
    let read;
    try {
        read = await readFeed(searchParams, fetchImpl);
    } catch (error) {
        return failure(error.message, error.status || 502);
    }
    const show = showFromFeed(read.parsed, read.finalUrl, offset);
    if (!show.total) return failure("This feed has no episodes to show.", 422);
    return json(show);
}

/** GET /api/v1/clip?f=…&eg|ea|eu=… — one episode, by the locator the app shares. */
export async function clipEndpoint(searchParams, { fetchImpl } = {}) {
    const problem = locatorProblem(searchParams, { needsIdentity: true });
    if (problem) return failure(problem, 400);

    let read;
    try {
        read = await readFeed(searchParams, fetchImpl);
    } catch (error) {
        return failure(error.message, error.status || 502);
    }
    const episode = matchEpisode(read.parsed, read.finalUrl, {
        guid: searchParams.get("eg"),
        atomId: searchParams.get("ea"),
        enclosure: searchParams.get("eu"),
        claimedPodcast: searchParams.get("pg"),
    });
    if (!episode) {
        return failure("That episode is not in this feed. You can still open the feed below.", 404);
    }
    if (!episode.audio) {
        return failure("This episode names no audio file in its feed.", 422);
    }
    return json({
        title: episode.title || "Episode",
        podcast: episode.podcast || "Podcast",
        audio: episode.audio,
        artwork: episode.artwork || null,
        episodeNumber: episode.episodeNumber || null,
        summary: episode.summary ? cut(episode.summary) : null,
        feed: episode.feed || null,
    });
}

/**
 * Answer `/api/v1/…`, or null when the address is not one of ours.
 *
 * Cached on the whole address, and — like the share route — only a GET may fill the cache.
 */
export async function handleApi(request, { fetchImpl } = {}) {
    const url = new URL(request.url);
    if (!/^\/api\/v1\/(?:clip|show)$/.test(url.pathname)) return null;

    if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(JSON.stringify({ error: "Only GET is allowed." }), {
            status: 405,
            headers: { "content-type": "application/json; charset=utf-8", allow: "GET, HEAD" },
        });
    }
    if (!originAllowed(request)) {
        return failure("This resolver answers only the woopod.com pages.", 403);
    }

    const cache = typeof caches !== "undefined" ? caches.default : null;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    if (cache) {
        const hit = await cache.match(cacheKey);
        if (hit) {
            const headers = new Headers(hit.headers);
            headers.set("x-woopod-api", "hit");
            return new Response(request.method === "HEAD" ? null : hit.body, { status: hit.status, headers });
        }
    }

    const endpoint = url.pathname.endsWith("/show") ? showEndpoint : clipEndpoint;
    let response;
    try {
        response = await endpoint(url.searchParams, { fetchImpl });
    } catch (error) {
        response = failure(error?.message || "The podcast resolver is unavailable.", 502);
    }

    if (response.ok) {
        const headers = new Headers(response.headers);
        headers.set("x-woopod-api", "resolved");
        response = new Response(response.body, { status: response.status, headers });
        if (cache && request.method === "GET") {
            try {
                await cache.put(cacheKey, response.clone());
            } catch { /* a cache write is a bonus, never a requirement */ }
        }
    }
    // A HEAD gets the status and the headers and nothing else, on success or on failure.
    if (request.method === "HEAD") {
        return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
}

// The route for woopod.com/p and /c: resolve the episode, then hand the page back with its preview.
//
// The page itself is the site's own HTML — this adds the tags between the markers and never draws a
// player. Tags and markers come from `player/share-metadata.mjs`, so there is exactly one
// implementation of the preview format and the website keeps owning it.
//
// Not one byte of a stranger's query is logged: it carries a note someone wrote and their clip bounds.

import { renderShareMetadata, shareMetadata } from "../player/share-metadata.mjs";
import { handleApi, showEndpoint } from "./api.mjs";
import { resolveEpisode } from "./resolver.mjs";

const CACHE_SECONDS = 300;

/** "clip", "episode", or null when this address is not one of ours. */
export function kindOf(pathname) {
    if (/^\/c\/?$/.test(pathname)) return "clip";
    if (/^\/p\/?$/.test(pathname)) return "episode";
    if (/^\/show\/?$/.test(pathname)) return "show";
    return null;
}

/**
 * Answer a preview request.
 *
 * `getPage()` supplies the site's own response for this address — `context.next()` on Cloudflare Pages,
 * or a fetch of the static origin for a Worker. Everything else is the same on both.
 *
 * Returns null when the address is not /p or /c, so the caller can pass it through untouched.
 */
export async function handle(request, { getPage, env = {}, resolveShow = showEndpoint } = {}) {
    const url = new URL(request.url);
    const kind = kindOf(url.pathname);
    if (!kind) return null;
    if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }

    // The cache key is the whole URL, note and bounds included: two clips of one episode must never
    // share an entry, which is the one way this feature could show someone the wrong thing.
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    if (cache) {
        const hit = await cache.match(cacheKey);
        if (hit) {
            const headers = new Headers(hit.headers);
            headers.set("x-woopod-preview", "hit");
            return new Response(request.method === "HEAD" ? null : hit.body, { status: hit.status, headers });
        }
    }

    let page;
    try {
        page = await getPage();
    } catch {
        page = null;
    }
    if (!page || !page.ok) {
        return new Response("this page is not published yet", {
            status: 404, headers: { "content-type": "text/plain; charset=utf-8" },
        });
    }

    const html = await page.text();
    let body = html;
    let resolved = null;
    try {
        if (kind === "show") {
            const show = await resolveShow(url.searchParams);
            if (show.ok) resolved = await show.json();
        } else resolved = await resolveEpisode(url.searchParams);
        body = renderShareMetadata(html, shareMetadata(url.toString(), resolved));
    } catch {
        // No markers, a dead feed, a nonsense locator: the player still has to open, so serve the page
        // exactly as the site published it and let the generic card stand.
        body = html;
    }

    const response = new Response(request.method === "HEAD" ? null : body, {
        status: 200,
        headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": `public, max-age=${CACHE_SECONDS}`,
            "x-woopod-preview": resolved ? "resolved" : "fallback",
            "x-content-type-options": "nosniff",
        },
    });
    // Only a GET may fill the cache. A HEAD is a request for the headers of a preview, not for the
    // preview: caching its empty body would hand every later unfurl a blank page for five minutes,
    // which is exactly the kind of bug that only shows up in production.
    if (cache && request.method === "GET") {
        try {
            await cache.put(cacheKey, response.clone());
        } catch { /* a cache write is a bonus, never a requirement */ }
    }
    return response;
}

/**
 * Cloudflare Pages entry point. `functions/[[path]].js` is a thin re-export of this so both routes are
 * caught whether or not the address carries its trailing slash.
 */
export async function onRequest(context) {
    const { request, env, next } = context;
    const api = await handleApi(request, { env });
    if (api) return api;
    const answer = await handle(request, { getPage: () => next(), env });
    return answer || next();
}

/**
 * The page a preview is injected into, cached on its own so that a thousand different clip links do
 * not mean a thousand reads of the same file.
 */
async function fetchPage(pageUrl) {
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const key = new Request(pageUrl, { method: "GET" });
    if (cache) {
        const hit = await cache.match(key);
        if (hit) return hit;
    }
    const response = await fetch(pageUrl, {
        headers: { "user-agent": "woopod share preview (+https://woopod.com)" },
    });
    if (cache && response.ok) {
        try {
            await cache.put(key, response.clone());
        } catch { /* a cache write is a bonus */ }
    }
    return response;
}

/**
 * Worker entry point: this in front of the static site, with a Worker route on `/p*` and `/c*` only.
 *
 * `PAGE_SOURCE` must not be the custom domain. GitHub redirects `stellarstoic.github.io/woopod/…` to
 * https://woopod.com/… once the repository carries a CNAME, and a Worker that follows that redirect
 * calls itself until Cloudflare stops it. The repository's raw address serves the same bytes with no
 * redirect: `https://raw.githubusercontent.com/StellarStoic/woopod/main/`.
 */
export function worker(env = {}) {
    const source = (env.PAGE_SOURCE || "https://raw.githubusercontent.com/StellarStoic/woopod/main/")
        .replace(/\/?$/, "/");
    return {
        async fetch(request) {
            const url = new URL(request.url);
            const api = await handleApi(request, { env });
            if (api) return api;
            const kind = kindOf(url.pathname);
            if (!kind) return fetch(request);
            const pageUrl = new URL(`${kind === "clip" ? "c" : kind === "show" ? "show" : "p"}/index.html`, source).toString();
            const answer = await handle(request, { env, getPage: () => fetchPage(pageUrl) });
            return answer || fetch(request);
        },
    };
}

/**
 * `worker(env)` is what the tests drive, giving each one its own config.
 *
 * The bundled artifact does not use this line: Cloudflare passes the bindings per request, so
 * `woopod_bundle_worker.py` writes a default export that reads `env` on every call instead of
 * closing over an empty one at import time. A secret set in the dashboard only reaches the code
 * through that path.
 */
export default worker();

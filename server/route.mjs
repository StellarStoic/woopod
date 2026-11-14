// The route for woopod.com/p and /c: resolve the episode, then hand the page back with its preview.
//
// The page itself is the site's own HTML — this adds the tags between the markers and never draws a
// player. Tags and markers come from `player/share-metadata.mjs`, so there is exactly one
// implementation of the preview format and the website keeps owning it.
//
// Not one byte of a stranger's query is logged: it carries a note someone wrote and their clip bounds.

import { renderShareMetadata, shareMetadata } from "../player/share-metadata.mjs";
import { resolveEpisode } from "./resolver.mjs";

const CACHE_SECONDS = 300;

/** "clip", "episode", or null when this address is not one of ours. */
export function kindOf(pathname) {
    if (/^\/c\/?$/.test(pathname)) return "clip";
    if (/^\/p\/?$/.test(pathname)) return "episode";
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
export async function handle(request, { getPage, env = {} } = {}) {
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
        resolved = await resolveEpisode(url.searchParams);
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
    if (cache) {
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
    const answer = await handle(request, { getPage: () => next(), env });
    return answer || next();
}

/**
 * Worker entry point, for putting this in front of a static origin instead of a Pages project.
 * Set `ORIGIN` to the site — today that is the GitHub Pages address that serves woopod.com.
 */
export function worker(env = {}) {
    const origin = (env.ORIGIN || "https://stellarstoic.github.io/woopod/").replace(/\/?$/, "/");
    return {
        async fetch(request) {
            const url = new URL(request.url);
            const kind = kindOf(url.pathname);
            if (!kind) return fetch(request);
            const pageUrl = new URL(`${kind === "clip" ? "c" : "p"}/index.html`, origin).toString();
            const answer = await handle(request, {
                env,
                getPage: () => fetch(pageUrl, {
                    headers: { "user-agent": "woopod share preview (+https://woopod.com)" },
                }),
            });
            return answer || fetch(request);
        },
    };
}

export default worker();

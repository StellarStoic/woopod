// RADIO STREAM RELAY — an HTTPS doorway to a station that only speaks HTTP.
//
// woopod.com is served over HTTPS. A browser playing `http://mp3.rtvslo.si:8000/val202` from that page
// gets a mixed-content block: the page cannot downgrade itself, whatever the JavaScript asks for. Only a
// same-origin HTTPS surface can reach an HTTP station, so this route does exactly that and nothing else.
//
// It is a proxy to the open internet, which is the shape of an SSRF hole, so every hop is checked:
//
//   * the address must be http or https, with a hostname, and no credentials or fragment;
//   * the hostname is resolved here (DNS-over-HTTPS) and every answer is checked against the private,
//     loopback and reserved ranges — a name that resolves to 127.0.0.1 or 192.168.1.1 is refused;
//   * a redirect is a new decision, not a continuation: at most three, each one re-checked the same way.
//
// One honest limit: Workers `fetch` resolves the name again when it connects, so a name that changes its
// answer between our lookup and the connection (DNS rebinding) is not caught. Closing that would mean
// connecting to the checked IP ourselves with a Host header, which the platform does not offer for TLS.
// The check is therefore strong against configuration mistakes and casual abuse, not against an attacker
// who controls a DNS server and times it — the same trade the existing feed resolver makes.

const RS_TIMEOUT_MS = 10_000;
const RS_MAX_REDIRECTS = 3;
const RS_USER_AGENT = "woopod-radio-relay/1.0 (+https://woopod.com)";

/** IPv4 ranges that are not the public internet. */
const V4_BLOCKS = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
    ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4ToInt(address) {
    const parts = address.split(".");
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const octet = Number(part);
        if (octet > 255) return null;
        value = value * 256 + octet;
    }
    return value;
}

function inV4Block(value, [base, bits]) {
    const baseValue = v4ToInt(base);
    const size = 2 ** (32 - bits);
    return Math.floor(value / size) === Math.floor(baseValue / size);
}

/** Is this IPv4 address anything other than a routable public one? */
export function isPrivateV4(address) {
    const value = v4ToInt(address);
    if (value === null) return true;                    // unparseable is not a destination
    return V4_BLOCKS.some(block => inV4Block(value, block));
}

function expandV6(address) {
    const text = String(address).toLowerCase().split("%")[0];   // drop a zone id
    if (!text.includes(":")) return null;
    let head = text;
    let tail = [];
    if (text.includes("::")) {
        const [left, right] = text.split("::");
        const leftParts = left ? left.split(":") : [];
        const rightParts = right ? right.split(":") : [];
        const missing = 8 - leftParts.length - rightParts.length;
        if (missing < 0) return null;
        head = [...leftParts, ...Array(missing).fill("0"), ...rightParts].join(":");
    }
    const groups = head.split(":");
    if (groups.length !== 8) return null;
    for (const group of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
        tail.push(parseInt(group, 16));
    }
    return tail;
}

/** Is this IPv6 address loopback, link-local, unique-local, multicast or otherwise not public? */
export function isPrivateV6(address) {
    const groups = expandV6(address);
    if (!groups) return true;
    const first = groups[0];
    // ::1 and :: are the loopback and the unspecified address
    if (groups.every((group, index) => group === 0 || (index === 7 && group === 1))) return true;
    if (groups.every(group => group === 0)) return true;
    if ((first & 0xfe00) === 0xfc00) return true;        // fc00::/7 unique-local
    if ((first & 0xffc0) === 0xfe80) return true;        // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true;        // ff00::/8 multicast
    if (first === 0x2001 && groups[1] === 0x0db8) return true;   // 2001:db8::/32 documentation
    // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) carry a v4 address: check that too
    const mapped = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff;
    if (mapped) {
        const v4 = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
        return isPrivateV4(v4);
    }
    const nat64 = first === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every(group => group === 0);
    if (nat64) {
        const v4 = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
        return isPrivateV4(v4);
    }
    return false;
}

export function isPrivateAddress(address) {
    const text = String(address || "").trim().toLowerCase();
    if (!text) return true;
    if (text.includes(":")) return isPrivateV6(text);
    return isPrivateV4(text);
}

/**
 * The requested station, or the reason it is not a station.
 *
 * `status` is what the caller answers: 400 for a request we will not look at, 403 for a destination we
 * will not reach. Keeping them apart matters — the first is a bug in the caller, the second is a refusal.
 */
export function parseRadioTarget(raw) {
    const value = String(raw || "").trim();
    if (!value) return {ok: false, status: 400, reason: "a stream address is required"};
    if (value.length > 2048) return {ok: false, status: 400, reason: "that address is too long"};
    let url;
    try {
        url = new URL(value);
    } catch {
        return {ok: false, status: 400, reason: "that is not a URL"};
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return {ok: false, status: 400, reason: "only http and https streams are relayed"};
    }
    if (!url.hostname) return {ok: false, status: 400, reason: "the address has no host"};
    if (url.username || url.password) return {ok: false, status: 403, reason: "an address with credentials is not relayed"};
    if (url.hash) return {ok: false, status: 400, reason: "the address carries a fragment, which never reaches a server"};
    return {ok: true, url};
}

/** DNS-over-HTTPS, because a Worker cannot call a resolver directly. */
async function resolveWithDoh(host, {fetchImpl}) {
    const answers = [];
    for (const type of ["A", "AAAA"]) {
        const address = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`;
        let response;
        try {
            response = await fetchImpl(address, {headers: {accept: "application/dns-json"}});
        } catch {
            throw Object.assign(new Error("dns lookup did not complete"), {kind: "dns"});
        }
        if (!response.ok) throw Object.assign(new Error(`dns answered ${response.status}`), {kind: "dns"});
        const body = await response.json().catch(() => null);
        for (const record of body?.Answer || []) {
            if (record?.type === 1 || record?.type === 28) answers.push(String(record.data || "").trim());
        }
    }
    return answers.filter(Boolean);
}

function textResponse(status, message, extra = {}) {
    return new Response(`${message}\n`, {
        status,
        headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            ...extra,
        },
    });
}

/**
 * Answer `GET /api/v1/radio-stream?u=…`, or null when this address is not that route.
 *
 * The body is piped, never read: a live stream has no end and no size, so buffering it would hold the
 * whole broadcast in memory and never answer. `no-store` keeps it out of every cache between here and
 * the listener, which is also what the station's terms expect.
 */
export async function radioStreamEndpoint(request, {fetchImpl = (...args) => fetch(...args), resolveHost = resolveWithDoh} = {}) {
    if (request.method !== "GET" && request.method !== "HEAD") {
        return textResponse(405, "only GET and HEAD are relayed", {allow: "GET, HEAD"});
    }
    const url = new URL(request.url);
    const target = parseRadioTarget(url.searchParams.get("u"));
    if (!target.ok) return textResponse(target.status, target.reason);

    let current = target.url;
    let upstream = null;
    for (let hop = 0; hop <= RS_MAX_REDIRECTS; hop++) {
        const host = current.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        // A literal address is its own answer: asking DNS about "192.168.0.1" would either echo it back or
        // fail, and failing would report 502 for what is plainly a refusal.
        const literal = /^[\d.]+$/.test(host) || host.includes(":");
        let addresses;
        if (literal) {
            addresses = [host];
        } else {
            try {
                addresses = await resolveHost(host, {fetchImpl});
            } catch {
                return textResponse(502, `${host} could not be resolved`);
            }
            if (!addresses.length) return textResponse(502, `${host} has no address`);
        }
        const refused = addresses.find(isPrivateAddress);
        if (refused) {
            return textResponse(403, literal
                ? `${host} is not a public address`
                : `${host} resolves to ${refused}, which is not a public station`);
        }

        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), RS_TIMEOUT_MS) : null;
        try {
            // Always a GET upstream, even for a HEAD from the caller: Icecast answers HEAD with 400 and
            // text/html, so asking it what the stream is needs a real request. The body is released the
            // moment the headers are in hand, which costs the station one open connection for a moment.
            upstream = await fetchImpl(current.toString(), {
                method: "GET",
                redirect: "manual",
                headers: {
                    // the stream itself, plus what a relayed request should say about itself
                    ...(request.headers.get("range") ? {range: request.headers.get("range")} : {}),
                    "icy-metadata": "1",
                    "user-agent": RS_USER_AGENT,
                    accept: "*/*",
                },
                signal: controller?.signal,
            });
        } catch (error) {
            const aborted = error?.name === "AbortError";
            return textResponse(aborted ? 504 : 502,
                aborted ? `${host} did not answer within ${RS_TIMEOUT_MS / 1000} seconds` : `${host} could not be reached`);
        } finally {
            // the deadline is for connecting, not for listening: a live stream would otherwise be cut off
            if (timer) clearTimeout(timer);
        }

        if ([301, 302, 303, 307, 308].includes(upstream.status)) {
            const location = upstream.headers.get("location");
            if (!location) return textResponse(502, `${host} redirected without a destination`);
            if (upstream.body) { try { await upstream.body.cancel(); } catch { /* nothing to release */ } }
            const next = parseRadioTarget(new URL(location, current).toString());
            if (!next.ok) return textResponse(next.status === 400 ? 403 : next.status,
                `a redirect to ${next.reason}`);
            current = next.url;
            continue;
        }
        break;
    }
    if (!upstream) return textResponse(502, "no answer from the station");
    if ([301, 302, 303, 307, 308].includes(upstream.status)) return textResponse(502, "too many redirects");

    const headers = new Headers({
        "content-type": upstream.headers.get("content-type") || "audio/mpeg",
        "cache-control": "no-store",
        "access-control-allow-origin": "https://woopod.com",
        "access-control-expose-headers": "icy-name, icy-genre, icy-br, icy-description",
        "x-content-type-options": "nosniff",
    });
    for (const name of ["icy-name", "icy-genre", "icy-br", "icy-description", "content-length", "content-range", "accept-ranges"]) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
    }

    // a HEAD asks what the stream is, not for the stream: the headers above came from a GET, and the body
    // is dropped here rather than piped
    if (request.method === "HEAD" || !upstream.body) {
        if (upstream.body) { try { await upstream.body.cancel(); } catch { /* nothing to release */ } }
        const status = upstream.status === 206 ? 206 : upstream.ok ? 200 : upstream.status;
        return new Response(null, {status, headers});
    }
    return new Response(upstream.body, {status: upstream.status === 206 ? 206 : 200, headers});
}

export {RS_TIMEOUT_MS, RS_MAX_REDIRECTS};

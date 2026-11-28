// The radio relay: an HTTPS doorway for a station that only speaks HTTP, and the guards that keep a
// proxy from becoming a hole in the network.
//
// Two things are tested here and nothing else: which destinations are refused and with which status, and
// that a stream is piped through rather than read. The DNS answers and the upstream responses are faked —
// the real ones are checked by hand after deployment, because a test that needs a live radio station goes
// red when the station does, which teaches nothing.

import test from "node:test";
import assert from "node:assert/strict";

import { handleApi } from "../server/api.mjs";
import {
    RS_MAX_REDIRECTS, isPrivateAddress, isPrivateV4, isPrivateV6, parseRadioTarget, radioStreamEndpoint,
} from "../server/radioStream.mjs";

const ROUTE = "https://woopod.com/api/v1/radio-stream";
const STATION = "http://mp3.rtvslo.si:8000/val202";

const answer = (body, status = 200, headers = {}) => new Response(body, {status, headers});

/** A DoH answer for one hostname. */
function dnsFor(map) {
    return async host => {
        if (!(host in map)) throw new Error("no such name");
        return map[host];
    };
}

/** Upstream responses by address. */
function upstreamFor(map) {
    const calls = [];
    const impl = async (url, init = {}) => {
        calls.push({url: String(url), init});
        for (const [match, respond] of map) if (String(url).includes(match)) return respond(String(url), init);
        return answer("not found", 404);
    };
    impl.calls = calls;
    return impl;
}

test("the private, loopback and reserved ranges are refused, and the public ones are not", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.1.1",
        "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
        "192.0.2.10", "203.0.113.9"]) {
        assert.equal(isPrivateV4(address), true, `${address} must be refused`);
    }
    for (const address of ["8.8.8.8", "1.1.1.1", "193.95.200.1", "172.15.0.1", "172.32.0.1", "192.169.0.1"]) {
        assert.equal(isPrivateV4(address), false, `${address} must be allowed`);
    }

    for (const address of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "2001:db8::1",
        "::ffff:127.0.0.1", "::ffff:192.168.0.5", "64:ff9b::7f00:1"]) {
        assert.equal(isPrivateV6(address), true, `${address} must be refused`);
    }
    for (const address of ["2606:4700:4700::1111", "2a00:1450:4001:80f::200e"]) {
        assert.equal(isPrivateV6(address), false, `${address} must be allowed`);
    }

    // anything unparseable is refused rather than guessed at
    assert.equal(isPrivateAddress(""), true);
    assert.equal(isPrivateAddress("not-an-address"), true);
    assert.equal(isPrivateAddress("1.2.3"), true);
});

test("only an http(s) address with a host, no credentials and no fragment is looked at", () => {
    assert.equal(parseRadioTarget(STATION).ok, true);
    assert.equal(parseRadioTarget("https://ice1.somafm.com/groovesalad-128-mp3").ok, true);
    // a station on an unusual port is the whole point of this route
    assert.equal(parseRadioTarget("http://stream.example.com:9000/live").ok, true);

    assert.equal(parseRadioTarget("").status, 400);
    assert.equal(parseRadioTarget("   ").status, 400);
    assert.equal(parseRadioTarget("not a url").status, 400);
    assert.equal(parseRadioTarget("ftp://host/stream").status, 400);
    assert.equal(parseRadioTarget("file:///etc/passwd").status, 400);
    assert.equal(parseRadioTarget(`http://host/${"a".repeat(2100)}`).status, 400);
    assert.equal(parseRadioTarget("http://user:pass@host/stream").status, 403, "credentials are a refusal, not a typo");
    assert.equal(parseRadioTarget("http://host/stream#frag").status, 400);
});

test("a stream is piped through with the station's own headers", async () => {
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array([0xff, 0xfb, 0x90, 0x00]));
            controller.close();
        },
    });
    const fetchImpl = upstreamFor([["mp3.rtvslo.si", () => new Response(body, {
        status: 200,
        headers: {"content-type": "audio/mpeg", "icy-name": "VAL 202", "icy-genre": "talk", "icy-br": "128"},
    })]]);
    const response = await radioStreamEndpoint(
        new Request(`${ROUTE}?u=${encodeURIComponent(STATION)}`),
        {fetchImpl, resolveHost: dnsFor({"mp3.rtvslo.si": ["193.95.200.1"]})});

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("access-control-allow-origin"), "https://woopod.com");
    assert.equal(response.headers.get("icy-name"), "VAL 202");
    assert.equal(response.headers.get("icy-br"), "128");
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...bytes], [0xff, 0xfb, 0x90, 0x00], "the body arrives unchanged");

    // what was asked of the station
    const call = fetchImpl.calls[0];
    assert.equal(call.init.redirect, "manual", "redirects must be walked by hand, each one re-checked");
    assert.equal(call.init.headers["icy-metadata"], "1");
    assert.match(call.init.headers["user-agent"], /woopod-radio-relay/);
});

test("a missing content type becomes audio/mpeg rather than nothing", async () => {
    // a ReadableStream body, because a string body makes Node invent a content-type of its own
    const bare = () => new Response(new ReadableStream({start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); }}), {status: 200});
    const fetchImpl = upstreamFor([["stream.example.com", bare]]);
    const response = await radioStreamEndpoint(new Request(`${ROUTE}?u=${encodeURIComponent("http://stream.example.com/live")}`),
        {fetchImpl, resolveHost: dnsFor({"stream.example.com": ["203.0.113.5", "8.8.8.8"].filter(a => a !== "203.0.113.5")})});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
});

test("a name that resolves into the house is refused with 403, before any connection", async () => {
    for (const address of ["127.0.0.1", "192.168.1.1", "10.0.0.5", "169.254.169.254", "::1", "fd00::1"]) {
        const fetchImpl = upstreamFor([]);
        const response = await radioStreamEndpoint(new Request(`${ROUTE}?u=${encodeURIComponent("http://radio.example.com/live")}`),
            {fetchImpl, resolveHost: async () => [address]});
        assert.equal(response.status, 403, `${address} must be refused`);
        assert.equal(fetchImpl.calls.length, 0, `nothing may be fetched for ${address}`);
    }
    // one private answer among public ones is enough to refuse
    const mixed = await radioStreamEndpoint(new Request(`${ROUTE}?u=${encodeURIComponent("http://radio.example.com/live")}`),
        {fetchImpl: upstreamFor([]), resolveHost: async () => ["193.95.200.1", "10.1.1.1"]});
    assert.equal(mixed.status, 403);
});

test("the failure statuses stay apart: 400 is a bad request, 403 a refusal, 502 a dead station, 504 a slow one", async () => {
    const badParam = await handleApi(new Request(`${ROUTE}?u=ftp%3A%2F%2Fhost%2F`), {env: {}, fetchImpl: upstreamFor([])});
    assert.equal(badParam.status, 400);

    const privateHost = await handleApi(new Request(`${ROUTE}?u=${encodeURIComponent("http://127.0.0.1/live")}`),
        {env: {}, fetchImpl: upstreamFor([]), resolveHost: async () => ["127.0.0.1"]});
    assert.equal(privateHost.status, 403);

    const unreachable = await handleApi(new Request(`${ROUTE}?u=${encodeURIComponent(STATION)}`),
        {env: {}, fetchImpl: async () => { throw new Error("connection refused"); }, resolveHost: dnsFor({"mp3.rtvslo.si": ["193.95.200.1"]})});
    assert.equal(unreachable.status, 502);

    const slow = await handleApi(new Request(`${ROUTE}?u=${encodeURIComponent(STATION)}`),
        {env: {}, fetchImpl: async () => { throw Object.assign(new Error("aborted"), {name: "AbortError"}); }, resolveHost: dnsFor({"mp3.rtvslo.si": ["193.95.200.1"]})});
    assert.equal(slow.status, 504);

    const unresolvable = await handleApi(new Request(`${ROUTE}?u=${encodeURIComponent("http://nowhere.example/live")}`),
        {env: {}, fetchImpl: upstreamFor([]), resolveHost: async () => []});
    assert.equal(unresolvable.status, 502);

    const post = await handleApi(new Request(ROUTE, {method: "POST"}), {env: {}, fetchImpl: upstreamFor([])});
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
});

test("redirects are walked by hand, and a hop into a private address stops the relay", async () => {
    const good = upstreamFor([
        ["first.example.com", () => new Response(null, {status: 302, headers: {location: "https://second.example.com/live"}})],
        ["second.example.com", () => new Response("mp3", {status: 200, headers: {"content-type": "audio/mpeg"}})],
    ]);
    const followed = await radioStreamEndpoint(new Request(`${ROUTE}?u=${encodeURIComponent("http://first.example.com/live")}`),
        {fetchImpl: good, resolveHost: dnsFor({"first.example.com": ["193.95.200.1"], "second.example.com": ["193.95.200.2"]})});
    assert.equal(followed.status, 200);
    assert.equal(good.calls.length, 2);
    assert.match(good.calls[1].url, /second\.example\.com/, "the location is followed");

    // the second hop is a new decision
    const intoHouse = upstreamFor([
        ["first.example.com", () => new Response(null, {status: 302, headers: {location: "http://192.168.0.1/admin"}})],
    ]);
    const refused = await radioStreamEndpoint(new Request(`${ROUTE}?u=${encodeURIComponent("http://first.example.com/live")}`),
        {fetchImpl: intoHouse, resolveHost: dnsFor({"first.example.com": ["193.95.200.1"]})});
    assert.equal(refused.status, 403);
    assert.equal(intoHouse.calls.length, 1, "the private hop must not be requested at all");
    assert.match(await refused.text(), /not a public address/);

    // credentials in a redirect are refused too
    const withCredentials = upstreamFor([
        ["first.example.com", () => new Response(null, {status: 301, headers: {location: "http://user:pass@second.example.com/x"}})],
    ]);
    const refusedCredentials = await radioStreamEndpoint(new Request(`${ROUTE}?u=${encodeURIComponent("http://first.example.com/live")}`),
        {fetchImpl: withCredentials, resolveHost: dnsFor({"first.example.com": ["193.95.200.1"], "second.example.com": ["193.95.200.2"]})});
    assert.equal(refusedCredentials.status, 403);
});

test("a redirect loop ends at the limit instead of running forever", async () => {
    let hop = 0;
    const impl = async () => {
        hop++;
        return new Response(null, {status: 302, headers: {location: `https://loop${hop}.example.com/live`}});
    };
    const response = await radioStreamEndpoint(new Request(`${ROUTE}?u=${encodeURIComponent("http://loop0.example.com/live")}`),
        {fetchImpl: impl, resolveHost: async () => ["193.95.200.1"]});
    assert.equal(response.status, 502);
    assert.match(await response.text(), /too many redirects|redirect/);
    assert.ok(hop <= RS_MAX_REDIRECTS + 1, `walked ${hop} hops, which is more than the limit allows`);
});

test("a HEAD asks what the stream is and takes no bytes", async () => {
    const fetchImpl = upstreamFor([["mp3.rtvslo.si", () => answer("unused", 200, {"content-type": "audio/aac", "icy-name": "VAL 202"})]]);
    const response = await radioStreamEndpoint(new Request(`${ROUTE}?u=${encodeURIComponent(STATION)}`, {method: "HEAD"}),
        {fetchImpl, resolveHost: dnsFor({"mp3.rtvslo.si": ["193.95.200.1"]})});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/aac");
    assert.equal(await response.text(), "");
});

test("the range header is passed on, so a caller can sample the first bytes", async () => {
    const fetchImpl = upstreamFor([["mp3.rtvslo.si", (url, init) => {
        assert.equal(init.headers.range, "bytes=0-99");
        return new Response("x".repeat(100), {status: 206, headers: {"content-type": "audio/mpeg", "content-range": "bytes 0-99/999"}});
    }]]);
    const response = await radioStreamEndpoint(
        new Request(`${ROUTE}?u=${encodeURIComponent(STATION)}`, {headers: {range: "bytes=0-99"}}),
        {fetchImpl, resolveHost: dnsFor({"mp3.rtvslo.si": ["193.95.200.1"]})});
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 0-99/999");
});

test("the route sits inside /api/v1 without disturbing the others", async () => {
    // the existing routes still answer null for an address that is not theirs
    assert.equal(await handleApi(new Request("https://woopod.com/api/v1/radiostream")), null);
    assert.equal(await handleApi(new Request("https://woopod.com/api/v1/radio-stream/extra")), null);
    assert.equal(await handleApi(new Request("https://woopod.com/p/")), null);
});

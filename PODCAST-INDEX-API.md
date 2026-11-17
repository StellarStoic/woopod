# Podcast Index search — API contract

Status: **implemented and tested, not deployed.** The route is in the Worker bundle
(`server/podcastindex.mjs`), but it answers `503 not_configured` until two Cloudflare Worker
secrets exist. Nothing below is live yet.

The credentials are set in Cloudflare, never in the app, the browser, the repository or a chat
message. Ask for the secret mechanism, not for the values.

---

## Endpoint

```
GET https://woopod.com/api/v1/pi/search
```

| parameter | required | values | default |
|---|---|---|---|
| `q` | yes | 1–120 characters after trimming; control characters are refused | — |
| `type` | no | `shows` · `episodes` · `both` (`people` is accepted as another word for `episodes`) | `shows` |
| `limit` | no | whole number 1–50; a larger value is clamped to 50 and the answer reports the limit used | `20` |

Any other query parameter is **ignored, not forwarded**. There is no way to reach another provider
endpoint, pass a URL, or add an upstream parameter through this route.

`HEAD` is answered with the same headers and no body. Anything but `GET`/`HEAD` is `405`.

No `Origin` header is required — a native app is expected. A browser call from any origin other than
`https://woopod.com` is refused, as on the other `/api/*` routes.

---

## Success

`200 application/json`, `cache-control: no-store`, `x-woopod-cache: off`.

```json
{
  "provider": "podcastindex",
  "query": "darknet",
  "type": "both",
  "limit": 3,
  "fetchedAt": "2026-11-17T16:26:53.509Z",
  "counts": { "shows": 1, "episodes": 1 },
  "results": {
    "shows": [ … ],
    "episodes": [ … ]
  },
  "partial": false,
  "errors": [],
  "notice": "Results are from the Podcast Index catalogue, not a search of every episode description. Merge on feedUrl or podcastGuid; episode guid and audioUrl are the provider's originals."
}
```

`results.shows` is present only when `type` asks for shows; `results.episodes` only when it asks for
episodes. An unasked part is **absent**, not an empty array — do not read `results.episodes === []`
as "nothing found".

### `results.shows[]`

```json
{
  "source": "podcastindex",
  "feedId": 920666,
  "podcastGuid": "a1b2c3d4-1111-2222-3333-444455556666",
  "title": "Darknet Diaries",
  "siteUrl": "https://darknetdiaries.com/",
  "feedUrl": "https://feeds.megaphone.fm/darknetdiaries",
  "artwork": "https://megaphone.imgix.net/dd.jpg",
  "description": "True stories from the dark side of the Internet.",
  "author": "Jack Rhysider",
  "ownerName": "Jack Rhysider",
  "language": "en",
  "explicit": false,
  "episodeCount": 168,
  "categories": ["Technology"],
  "lastUpdate": "2025-11-12T23:26:40.000Z",
  "newestItem": "2025-11-11T22:26:40.000Z",
  "itunesId": 1322098607,
  "dead": false
}
```

- `feedUrl` is the provider's own feed address — the value to subscribe to and to merge on.
- `description` is truncated to 400 characters (the workspace list needs a line, not an article).
- Any field can be `null` when the provider has nothing for it.

### `results.episodes[]`

```json
{
  "source": "podcastindex",
  "providerEpisodeId": 66677000001,
  "guid": "dd-ep-168",
  "title": "Ep 168: The Laziest Hacker",
  "feedId": 920666,
  "feedTitle": "Darknet Diaries",
  "feedUrl": "https://feeds.megaphone.fm/darknetdiaries",
  "artwork": "https://megaphone.imgix.net/dd.jpg",
  "audioUrl": "https://traffic.megaphone.fm/DD.m4a",
  "audioType": "audio/mp4",
  "audioLength": 41943040,
  "duration": 3300,
  "datePublished": "2025-11-11T22:26:40.000Z",
  "explicit": false,
  "episodeNumber": 168,
  "season": null,
  "episodeType": "full",
  "siteUrl": "https://darknetdiaries.com/episode/168/",
  "chaptersUrl": null,
  "transcriptUrl": null
}
```

- `guid` and `audioUrl` are the provider's **originals**, so the app can match an episode against a
  subscription without trusting titles.
- `duration` is seconds.

### Merging, in one paragraph

Match a show on `podcastGuid` first, then on `feedUrl`; `feedId` is the provider's own identifier and
is stable, but it is not something the app can compute. Match an episode on `feedUrl` + `guid`, then
fall back to `audioUrl`, then to `title` + `datePublished`. Never merge on title alone.

---

## Failure

Every failure is `application/json` with `cache-control: no-store`:

```json
{ "error": { "code": "query_missing", "field": "q", "message": "A search needs a q parameter." }, "provider": "podcastindex" }
```

| HTTP | `error.code` | when | what the app should do |
|---|---|---|---|
| 400 | `query_missing` · `query_too_long` · `query_invalid` · `type_invalid` · `limit_invalid` | the request is not what this endpoint accepts; `field` names it | fix the request; do not retry |
| 405 | — (`error` is a string) | a method other than `GET`/`HEAD` | fix the request |
| 429 | `rate_limited` | this address exceeded 30 searches in a minute | wait `retryAfter` seconds (also sent as `retry-after`) |
| 429 | `provider_rate_limited` | **the provider** is limiting us | back off; this is not the app's fault |
| 502 | `provider_auth_failed` | the provider refused our credentials — an operator problem | show a soft "search unavailable", do not surface the reason as the user's fault |
| 502 | `provider_unavailable` · `provider_rejected` · `provider_error` | the provider failed or answered something unexpected | retry once, then degrade |
| 503 | `not_configured` | the deployment has no Podcast Index credentials yet | treat search as absent, not as an error |
| 504 | `provider_timeout` | the provider did not answer within 8 s | retry once |

Provider error bodies are **never** passed through — they can quote the request, and the request is
signed. The category is all the app gets.

### Partial results

With `type=both`, the two provider calls are independent. If one fails and the other answers, the
response is `200` with `partial: true` and the failure described in `errors`:

```json
{ "partial": true, "counts": { "shows": 12, "episodes": 0 },
  "errors": [ { "part": "episodes", "status": 502, "code": "provider_unavailable", "message": "…" } ] }
```

Render what arrived, and say the rest is missing. Only when **both** parts fail does the request
answer with an error status.

---

## Limits and behaviour worth knowing

- **Rate limit:** 30 requests per minute per client address, best effort. A Worker runs in many
  isolates, each with its own memory, so this is a cost guard and not a security boundary. The real
  ceiling is the provider's quota, which the app is told about rather than shielded from.
- **Timeout:** 8 s per provider call, then `504 provider_timeout`.
- **Caching:** **none.** `cache-control: no-store`, `x-woopod-cache: off`, and the route deliberately
  bypasses the edge cache the share pages use. The Podcast Index terms have to be read for what may
  be retained and for how long before any query is stored at the edge; until that review happens,
  nothing is.
- **Privacy / what is kept:** the query is not logged, stored or counted by us. Rate-limit counters
  live in Worker memory, are keyed by client address and expire after a minute; nothing is written
  to storage, KV, D1 or an analytics product. Cloudflare's own request logs exist as they do for
  every request to the zone. No subscription list, feed address or account identifier is ever sent
  upstream — the only thing that leaves is `q`, `max` and our signed headers.

## What this is not

- **Not exhaustive episode search.** `shows` searches the catalogue's show index. `episodes`
  (`byperson`) finds episodes by a person's name; it is not a full-text search of every episode
  description, and the answer says so in `notice` so the app can repeat it.
- **No people resource.** The provider has none; `type=episodes` is what "search people" means here.
- **No `/episodes/byfeedid`, no categories, no live episodes, no batched update checks yet.** Each of
  those needs its own reviewed contract: `byfeedid` in particular has to survive incomplete or stale
  index data and must keep RSS as the fallback, and it must never carry a private feed address.

## Test query (no credentials in it)

```sh
curl -s 'https://woopod.com/api/v1/pi/search?q=darknet&limit=3'
# until the secrets exist: 503 {"error":{"code":"not_configured", …}}
# afterwards:          200 with three shows from the catalogue
```

## Operator notes

- Secrets: `PI_API_KEY`, `PI_API_SECRET`, set as Worker **secrets** on `woopod-share`
  (`wrangler secret put`, or the dashboard), never as plain variables — a plain variable is readable
  in the dashboard and in the uploaded script.
- The endpoint needs no other configuration. If `PI_CACHE_SECONDS` is ever added, whatever it enables
  must be justified by the provider's terms first.
- The signed headers are `User-Agent`, `X-Auth-Key`, `X-Auth-Date` and
  `Authorization = sha1(key + secret + unixSeconds)`, lower-case hex, valid in a three-minute window.
  Verified against the live API: with a deliberately invalid key the provider names the **key** as
  invalid, which is the answer a correct signature scheme produces.

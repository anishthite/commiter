# Research: Twitter/X syndication endpoint viability — late 2025 / early 2026

## Summary

**The single-tweet endpoint `https://cdn.syndication.twimg.com/tweet-result?id=…&token=…` still works unauthenticated, with the original react-tweet token algorithm unchanged on the `main` branch.** The *profile* timeline endpoint `https://syndication.twitter.com/srv/timeline-profile/screen-name/<handle>` is partially dead: twittxr (the canonical wrapper) now mandates session cookies, `showReplies=true` is broken, the emusks reverse-engineering doc states profile timelines "have been effectively removed from the embeds API and no longer work," and there is no token-only path that returns a clean JSON list of recent tweets. For a working unauthenticated feed in 2026, the realistic recipe is **Nitter RSS** (xcancel.com / nitter.net) for tweet ID discovery, plus `tweet-result` for hydration.

## Findings

### 1. The two endpoints behave very differently — only one is still "free + unauth"

1. **`cdn.syndication.twimg.com/tweet-result` is alive and returns clean JSON for a single tweet ID, no auth.** Exact URL from `react-tweet@main`:
   `https://cdn.syndication.twimg.com/tweet-result?id=<id>&lang=en&features=<feature flags>&token=<derived>`. The `features` param is a `;`-separated list of `tfw_*` flags and is *recommended but not strictly required* in practice — Terence Eden's April 2025 walkthrough confirms `?id=…&token=123` alone returns the same JSON. [react-tweet fetch-tweet.ts](https://github.com/vercel/react-tweet/blob/main/packages/react-tweet/src/api/fetch-tweet.ts), [Terence Eden, Apr 2025](https://shkspr.mobi/blog/2025/04/you-dont-need-an-api-key-to-archive-twitter-data/)

2. **`syndication.twitter.com/srv/timeline-profile/screen-name/<handle>` is degraded and now requires a logged-in cookie.** It does *not* return JSON — it returns an HTML page with the timeline JSON inside a `<script id="__NEXT_DATA__">` block (read `props.pageProps.timeline.entries`). twittxr's README (current) is explicit: *"Twitter is now known to require a cookie to return timeline data. I strongly advise you pass the `cookie` parameter in all of your requests"* — meaning `guest_id`, `auth_token`, `ct0`, `kdt`. [twittxr README](https://github.com/Owen3H/twittxr), [twittxr timeline.ts](https://github.com/Owen3H/twittxr/blob/main/src/classes/timeline.ts)

3. **The emusks reverse-engineering reference (current, 2026-dated entries) flatly states profile timelines are gone**: *"This API only supports fetching tweets as profile timelines have been effectively removed from the embeds API and no longer work."* [emusks Syndication API](https://emusks.tiago.zip/more/syndication). The nitter issue thread confirms `showReplies=true` is broken and the base URL only returns a small set ordered by like count, not chronologically. [nitter#983](https://github.com/zedeus/nitter/issues/983)

**Honest read:** if you need to *list* a handle's recent tweets without an account, `srv/timeline-profile/screen-name/<handle>` is not a 2026 solution. It is the same shape that powered "profile embeds" which Twitter intentionally killed.

### 2. Token algorithm — unchanged for `tweet-result`, and effectively not validated

The standard react-tweet trick is **still in `main` as of 2026**, unmodified:

```js
function getToken(id) {
  return ((Number(id) / 1e15) * Math.PI)
    .toString(6 ** 2)        // base 36
    .replace(/(0+|\.)/g, '');
}
```
[`packages/react-tweet/src/api/fetch-tweet.ts` @ main](https://github.com/vercel/react-tweet/blob/main/packages/react-tweet/src/api/fetch-tweet.ts)

Terence Eden independently verified (Apr 2025) that the token *is not actually validated server-side* — `&token=123` or any non-empty value returns the same JSON. He notes one quirk: *"Sometimes the API stops responding. Change the token to another random number."* — so when you get a degraded response, rotating the token is a real (cheap) retry. [Terence Eden](https://shkspr.mobi/blog/2025/04/you-dont-need-an-api-key-to-archive-twitter-data/)

**Working curl (single tweet):**
```bash
# Minimal — token can be a random integer string
curl -sS 'https://cdn.syndication.twimg.com/tweet-result?id=1629307668568633344&token=4' \
  -H 'User-Agent: Mozilla/5.0' | jq .

# Faithful react-tweet reproduction
ID=1629307668568633344
TOKEN=$(node -e "console.log((($ID/1e15)*Math.PI).toString(36).replace(/(0+|\.)/g,''))")
curl -sS "https://cdn.syndication.twimg.com/tweet-result?id=$ID&lang=en&token=$TOKEN" \
  -H 'User-Agent: Mozilla/5.0'
```

There is no working `curl` for a *profile timeline* without a session cookie. If you have one, twittxr's request shape is just `GET https://syndication.twitter.com/srv/timeline-profile/screen-name/<handle>` with the cookie header.

### 3. Response shape

**Per-tweet JSON from `tweet-result`** (confirmed against react-tweet's TS types, emusks docs dated 2026, and Terence Eden's 2025 dump):

| Field | Notes |
|---|---|
| `__typename` | `"Tweet"`, `"TweetTombstone"` (deleted), or `"TweetUnavailable"` |
| `id_str` | numeric string |
| `text` | the rendered text (NOT `full_text` — that field is on the *timeline* shape, not `tweet-result`) |
| `created_at` | **ISO-8601 UTC with `.000Z`**, e.g. `"2026-02-16T11:24:04.000Z"` — directly `new Date()`-parseable |
| `lang` | BCP47 |
| `favorite_count` | integer |
| `conversation_count` | integer (rough reply count) |
| `entities` | `hashtags`, `urls`, `user_mentions`, `symbols`, `media` |
| `mediaDetails` / `photos` / `video` | image + video variants (raw mp4 URLs included) |
| `user` | `id_str`, `screen_name`, `name`, `is_blue_verified`, `profile_image_url_https`, `profile_image_shape` — **no follower counts, no description** |
| `parent` | full nested tweet object when it's a reply |
| `quoted_tweet` | full nested tweet object when it quotes |
| `edit_control` | edit history metadata |
| `isEdited`, `isStaleEdit` | booleans |
| `news_action_type` | `"conversation"` etc. |

Notes on what's **missing vs the v1.1 / GraphQL shapes**: no `retweet_count` on `tweet-result` (you get `favorite_count` and `conversation_count` only); reply/quote metadata is present but as embedded parent/quoted objects, not flat IDs alone. Per Terence Eden: *"The counts for replies, retweets, and favourites may not be accurate. Older messages seem worse for this."* [shkspr.mobi](https://shkspr.mobi/blog/2025/04/you-dont-need-an-api-key-to-archive-twitter-data/)

**Per-tweet JSON from the (degraded) timeline-profile HTML** — extracted from `__NEXT_DATA__`, twittxr's `RawTimelineTweet`: has `id_str`, `text`, `full_text`, `display_text_range`, `created_at`, `permalink`, `quote_count`, `reply_count`, `retweet_count`, `favorite_count`, `user`, `entities`, `retweeted_status`, `in_reply_to_name`. Twittxr docs: *"only up to 100 Tweets can be returned. (May be 20 in some cases)"* — but this is **historical**; with the post-2024 changes the realistic count is at the low end and ordering may not be chronological.

**Rate limits:** emusks claims "no ratelimits" for `tweet-result`. react-tweet docs explicitly warn that *"the IPs of the server are making many requests to the syndication API"* can get rate-limited from one IP — i.e. it's not strict but it is present and IP-scoped. For Vercel's hosted demo endpoint, users *have* hit it (issue #151). Practical: a few QPS from a single IP is fine; bursts of hundreds will not be.

### 4. react-tweet on Vercel itself: cracks but not collapsed

| Issue | Status | Signal |
|---|---|---|
| [#202 "Tweet not found"](https://github.com/vercel/react-tweet/issues/202) | OPEN, filed 2025-09-20 | Demo `react-tweet-next.vercel.app/light/1629307668568633344` returns "tweet not found". Indicates the production hosted endpoint hit a bad window. |
| [#201 "Profile images 404"](https://github.com/vercel/react-tweet/issues/201) | OPEN, 2025-09-10 | X changed avatar URL hashing; only affects historical tweets. |
| [#212 "Videos blocked 403"](https://github.com/vercel/react-tweet/issues/212) | OPEN, 2025-12-23, 20 👍 by Feb 2026 | Video CDN started returning 403 to embeds. Tweet JSON still loads — only video bytes are blocked. |
| [#151 "404 from react-tweet.vercel.app/api/tweet"](https://github.com/vercel/react-tweet/issues/151) | OPEN since 2023 | The hosted SWR endpoint is rate-limit prone. |

**Source code on `main` has not changed the algorithm** as of this writing — Vercel is still using exactly the `((id/1e15)*Math.PI).toString(36)` trick. Translation: the *library* is still betting on `tweet-result`. The breakage they're tracking is cosmetic (avatars, video bytes) plus intermittent "not found" from the API, not a token-scheme change.

### 5. Alternatives, ranked (free / unauth, May 2026)

1. **`cdn.syndication.twimg.com/tweet-result` (per-tweet, ID-driven)** — *most reliable.* Truly unauth, token is unvalidated, JSON is rich, no chronic breakage as of late May 2026. Limitation: **you need the tweet IDs already.** No way to enumerate a profile from this endpoint alone.

2. **Nitter via `xcancel.com` and a handful of other healthy instances** — *the actual answer for "give me a handle's recent tweets unauthenticated in 2026."* Per [status.d420.de](https://status.d420.de/) snapshot 2026-05-28/29:
   - `nitter.net` — 95% uptime, no RSS exposed
   - `xcancel.com` — 97% uptime, **RSS supported** ✅
   - `nitter.privacyredirect.com` — 91% uptime, RSS ✅
   - `nitter.poast.org` — 86% uptime, RSS ✅
   - `nitter.tiekoetter.com` — 45% uptime (fast but flaky)
   - `nitter.catsarch.com` — 69% uptime, no RSS

   The fetch shape: `https://xcancel.com/<handle>/rss` returns an Atom feed with the last ~20 tweets, each with status URL and ISO timestamp. **Hard constraint from maintainers**: *"Please do NOT use these instances for scraping, host nitter yourself."* For low-volume personal use (a few handles, polled every N hours) the public instances are realistic; anything industrial requires `git clone zedeus/nitter && docker compose up`.

3. **rettiwt-api (`Rishikant181/Rettiwt-API`)** — *actively maintained.* Latest release **v6.1.7 on 2025-12-24**, and v6.1.5 explicitly "Updated all Twitter API endpoints." Guest auth (no login) still grants tweet/user reads; user auth (cookies) unlocks the rest. Login flow is currently flaky (issue #586). [releases](https://github.com/Rishikant181/Rettiwt-API/releases). Reliability: high relative to the field, but you are now riding the maintainer's whack-a-mole with X's GraphQL changes, not a stable endpoint.

4. **twittxr** — wraps the dying `srv/timeline-profile` endpoint with a Puppeteer fallback. Still maintained, but **now requires session cookies**, which by definition makes it not the "free + unauth" option you asked about.

5. **RSSHub Twitter routes** — *do not rely on these.* Per issues #19487, #21544, #16014, #14439: X rotates GraphQL query IDs every 2–4 weeks, the public-facing RSSHub instance returns 404/403 most weeks, and the official guidance is to self-host and feed it cookies. As an unauth answer in 2026 this is dead.

6. **Honorable mentions** — twitterapi.io / scraping aggregators with free tiers exist (the dev.to "Scraping Twitter in 2025" piece picks twitterapi.io as the winner with 100K free credits) but that's paid-with-free-tier, not strictly unauth.

### 6. `created_at` format — confirmed ISO-8601 UTC

For `tweet-result`: `"created_at": "2026-02-16T11:24:04.000Z"` (verified against emusks 2026 sample and shkspr.mobi 2025 dump).
For the timeline-profile shape: same format (`created_at` is a string, identical layout).

This is `new Date(t.created_at)`-safe. To bucket into America/Los_Angeles days:

```js
const day = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(tweet.created_at));  // -> "2026-02-16"
```

Note: legacy v1.1 `created_at` (`"Wed Oct 10 20:19:24 +0000 2018"`) does **not** appear in either syndication shape. You only meet the legacy format if you scrape `/i/api/1.1/...` directly.

### 7. Failure modes — what "feed offline" looks like

| Trigger | Response from `tweet-result` |
|---|---|
| Tweet deleted | `200 OK` + `{ "__typename": "TweetTombstone", "tombstone": { "text": {...} } }` |
| Tweet never existed / wrong ID | `404` *or* `200 OK` with empty `{}` (react-tweet treats both as `notFound`) |
| Account suspended | `TweetTombstone` shape, same as deletion |
| Tweet exists but API hiccup | `200 OK` with empty `{}` — Terence Eden's advice: retry with a different token |
| IP rate-limited / bot-suspected | `403 Forbidden`, typically HTML body (Cloudflare-style challenge), no JSON content-type. react-tweet throws `TwitterApiError`. |
| Video fetch blocked but tweet JSON OK | tweet JSON returns fine; only `video.twimg.com/...mp4` URLs return 403 (issue #212) |

**Detection logic** (lifted from react-tweet's `fetchTweet`):
```js
if (!res.ok && res.status === 404) return { notFound: true };
const isJson = res.headers.get('content-type')?.includes('application/json');
const data = isJson ? await res.json() : undefined;          // HTML challenge → undefined
if (data?.__typename === 'TweetTombstone') return { tombstone: true };
if (data && Object.keys(data).length === 0) return { notFound: true };
if (!isJson || !data) return { feedOffline: true };          // your own bucket
return { data };
```

For profile timelines (if you go that route): expect a `200 OK` HTML page where `__NEXT_DATA__.props.pageProps.timeline.entries` is either missing entirely (auth required) or an empty array (no public tweets / rate-limited). twittxr surfaces both as a `ParseError`/`FetchError`.

## Sources

**Kept:**
- [react-tweet fetch-tweet.ts @ main](https://github.com/vercel/react-tweet/blob/main/packages/react-tweet/src/api/fetch-tweet.ts) — canonical token algorithm, currently shipping, unchanged.
- [emusks Syndication API doc](https://emusks.tiago.zip/more/syndication) — reverse-engineered reference with 2026-dated examples; declares profile timeline endpoint dead.
- [Terence Eden "You don't need an API key" (Apr 2025)](https://shkspr.mobi/blog/2025/04/you-dont-need-an-api-key-to-archive-twitter-data/) — independent verification that `token` is unvalidated; rich JSON shape samples.
- [twittxr README + timeline.ts](https://github.com/Owen3H/twittxr) — confirms profile-timeline endpoint now needs cookies in 2025/2026.
- [react-tweet issues #201, #202, #212](https://github.com/vercel/react-tweet/issues/212) — current breakage trail (avatars, "not found", video 403s) into Feb 2026.
- [status.d420.de Nitter instance health](https://status.d420.de/) — live uptime snapshot 2026-05-28/29.
- [zedeus/nitter#983](https://github.com/zedeus/nitter/issues/983) — confirms `showReplies=true` broken on syndication.
- [Rettiwt-API v6.1.4–v6.1.7 releases (Dec 2025)](https://github.com/Rishikant181/Rettiwt-API/releases) — endpoint refresh evidence, still actively maintained.
- [DIYgod/RSSHub Twitter route issues #19487, #21544, #16014](https://github.com/DIYgod/RSSHub/issues/21544) — confirms RSSHub Twitter is unreliable without cookies.
- [samwize "X.com embed disaster" (Aug 2025)](https://samwize.com/2025/08/10/the-x-com-embed-disaster-still-broken-but-we-have-a-reverse-engineered-solution/) — corroborates `tweet-result` is the way, replicates the token formula.

**Dropped:**
- *jasonmayes/Twitter-Post-Fetcher* (issue #221, 2023) — stale, predates current endpoints.
- *Mintlify "X recommendation algorithm"* / *docs.x.com* — describes official paid API, not relevant to the free unauth question.
- *Generic "Scraping Twitter in 2025" dev.to post* — useful framing but its winner pick (`twitterapi.io`) is paid-with-credits, outside the unauth scope.
- *npmx twittxr listing* — duplicate of the GitHub README.

## Gaps

- **No live curl performed** in this research — couldn't physically verify "right now, May 28 2026" against the running endpoint from this sandbox. The brief leans on (a) source code on `react-tweet@main` being current and unchanged and (b) very recent issue activity (Feb 2026) where contributors are still using the endpoint successfully for tweet bodies. Suggested next step: hit `curl 'https://cdn.syndication.twimg.com/tweet-result?id=1629307668568633344&token=4'` and `curl https://xcancel.com/elonmusk/rss` from the deploy environment before committing the architecture.
- **No empirical IP rate-limit threshold** — couldn't find a published number. Plan as if ~1 QPS sustained / short bursts of ~10 are safe; assume anything heavier triggers 403.
- **No firm answer on whether `srv/timeline-profile` will work from a server with *guest* cookies only** (i.e. `guest_id` + `gt` without `auth_token`). twittxr's README implies you need real login cookies. If guest-only works, the unauth path partially reopens — worth a 5-minute test.
- **No data on `xcancel.com`'s own rate limits / blocking patterns.** Maintainers say "don't scrape" but don't publish a number. If this becomes a primary feed, self-hosting Nitter is the only durable answer.

## Recommendation (ruthlessly honest)

For the question *"can I use `syndication.twitter.com/srv/timeline-profile/screen-name/<handle>` as a free unauth source of a user's recent tweets in late 2025 / early 2026?"* — **no, not reliably, and not without a logged-in session cookie that defeats the "unauth" framing.**

The 2026 architecture that actually works:

1. **Discovery / listing** → `https://xcancel.com/<handle>/rss` (or another healthy Nitter w/ RSS, with rotating fallback). Gives you recent tweet IDs and timestamps.
2. **Hydration / rich metadata** → `https://cdn.syndication.twimg.com/tweet-result?id=<id>&token=<derived-or-random>` per tweet. Gives you `created_at` (ISO-8601 UTC), text, media, entities, parent/quoted tweets.
3. **Bucketing** → `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', ... })` on `tweet.created_at` produces a clean `YYYY-MM-DD` Pacific day key.
4. **"Feed offline" detection** → react-tweet's branch logic: non-JSON content-type, empty object, or `__typename === 'TweetTombstone'` → mark offline / deleted respectively. Cache aggressively; retry with rotated token before declaring offline.

If you want to skip the Nitter dependency, **rettiwt-api in guest mode** is the next-best single dependency and is actively maintained (latest release 4 days before Christmas 2025) — but you're delegating endpoint maintenance to one person racing X's GraphQL rotations.

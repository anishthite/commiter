# Scout: Twitter syndication endpoint viability

## Status: ✅ done

- [x] Kick off parallel research across 4 angles
- [x] Verify token algorithm with primary source (react-tweet@main — unchanged)
- [x] Confirm response shape (ISO-8601 UTC `created_at`)
- [x] Survey alternatives (nitter status.d420.de live snapshot, rettiwt v6.1.7 Dec 2025, RSSHub, twittxr)
- [x] Write brief → scout-twitter-syndication.md

## Top-line answer

- **`cdn.syndication.twimg.com/tweet-result?id=…&token=…`** — single-tweet endpoint, alive, unauth, token unvalidated, react-tweet algorithm unchanged on main.
- **`syndication.twitter.com/srv/timeline-profile/screen-name/<handle>`** — partially dead. Returns HTML w/ `__NEXT_DATA__`, now requires login cookies per twittxr, `showReplies=true` broken, emusks doc says "effectively removed".
- **Realistic 2026 unauth recipe:** Nitter RSS (xcancel.com) for listing + `tweet-result` for hydration.
- `created_at` is ISO-8601 UTC `.000Z` — easy LA-day bucketing via `Intl.DateTimeFormat`.
- Failure modes: 404, empty `{}`, `__typename === "TweetTombstone"`, or non-JSON 403 HTML challenge.

# Self-hosting Nitter on Fly.io (for the Twitter panel)

> tl;dr: ~1h setup, $0/mo if you stay on Fly.io's free shared-cpu tier.
> Creates a personal `your-nitter.fly.dev` that gives us a clean
> chronological X feed via RSS without our app holding any X credentials
> or paying a third-party scraping API.

## Why this exists

The dashboard's Twitter panel needs your handle's recent tweet
timestamps. In 2026 the unauth options are dead:

- **Public Nitter pool** (nitter.net, xcancel, etc.) — usually blocked
  from Vercel's datacenter IPs; works on residential IPs.
- **syndication.twitter.com** — returns 6–7 months stale curated data,
  not a live timeline (verified empirically against @paulg, @sama, @dhh).
- **Official X API** — $200/mo minimum tier. Nope.

The remaining options that actually work in 2026:

| Option | Where the X cookies live | $/mo |
|---|---|---|
| `rettiwt-api` in Vercel env var | Vercel (your **real** account) | $0 |
| Paid scraping API (twitterapi.io, GetXAPI) | Their backend | $1–5 |
| **Self-host Nitter on Fly.io** (this guide) | Your Fly.io VM (**burner** account) | $0 |

Self-host wins on the **threat model**: the cookies live on a box you
control, represent a throwaway X account with no real-life ties, and
can be revoked any time by logging that burner out.

## Prerequisites

- A **Fly.io** account ([fly.io](https://fly.io)) and `flyctl` installed
  locally (`brew install flyctl` on macOS).
- A **burner X account** — DO NOT use your real account for this.
  - Create at [x.com/signup](https://x.com/signup) with a fresh email
    (e.g. `you+nitter@gmail.com` works for Gmail aliasing).
  - **No 2FA.** Nitter's session importer can't currently handle 2FA-
    protected logins. The burner has nothing valuable on it, so leaving
    it without 2FA is a reasonable trade.
  - "Like" or follow one random account so X considers the signup
    complete; otherwise the session cookies it issues won't be valid
    for API reads.

## Step 1 — Get the burner's session cookies

In a fresh **incognito window**:

1. Log in to x.com as the burner.
2. Open DevTools → Application → Cookies → `https://x.com`.
3. Copy these two values to a scratch file (you'll need them in step 3):
   - `auth_token` (the long hex string)
   - `ct0` (the CSRF token)
4. Also note the burner's `username` and numeric `id`. You can find the
   `id` by visiting `https://x.com/i/api/1.1/users/show.json?screen_name=<burner-handle>`
   in the same browser (returns JSON with `"id_str"`); or use the
   `id` value from any cookie/profile URL.
5. **Don't log the burner out.** That invalidates `auth_token`. Just
   close the incognito window.

## Step 2 — Scaffold the Fly app

Create a new directory (NOT inside this repo — keep the Nitter deploy
independent of the dashboard repo):

```bash
mkdir ~/code/my-nitter && cd ~/code/my-nitter
```

### `Dockerfile`

```dockerfile
FROM zedeus/nitter:latest

# nitter expects sessions.jsonl in the working directory; we mount it
# via fly secrets at runtime (see step 3).
WORKDIR /src

# Tell nitter where to find the sessions file.
ENV NITTER_SESSIONS_FILE=/data/sessions.jsonl

# Default config is at /src/nitter.conf inside the upstream image;
# we override it with our own at runtime.
CMD ["/src/nitter"]
```

### `nitter.conf`

```ini
[Server]
address = "0.0.0.0"
port = 8080
https = false
httpMaxConnections = 100
staticDir = "/src/public"
title = "personal nitter"
hostname = "your-nitter.fly.dev"     # replace after step 4

[Cache]
listMinutes = 240
rssMinutes = 10
redisHost = "localhost"
redisPort = 6379
redisPassword = ""
redisConnections = 20
redisMaxConnections = 30

[Config]
hmacKey = "REPLACE_ME_WITH_RANDOM_32_CHARS"
base64Media = false
enableRSS = true
enableDebug = false
proxy = ""
proxyAuth = ""
tokenCount = 10

[Preferences]
theme = "Nitter"
replaceTwitter = "your-nitter.fly.dev"
replaceYouTube = ""
replaceReddit = ""
replaceInstagram = ""
proxyVideos = true
hlsPlayback = false
infiniteScroll = false
```

Generate the `hmacKey` with `openssl rand -hex 16` and paste it in.

### `fly.toml`

```toml
app = "your-nitter"   # must be globally unique on Fly
primary_region = "iad"  # or "lax", "fra", etc. Pick one close to Vercel.

[build]
  dockerfile = "Dockerfile"

[mounts]
  source = "nitter_data"
  destination = "/data"

[[services]]
  internal_port = 8080
  protocol = "tcp"
  auto_stop_machines = "stop"     # Fly's free tier loves this
  auto_start_machines = true
  min_machines_running = 0

  [[services.ports]]
    handlers = ["http"]
    port = 80
    force_https = true

  [[services.ports]]
    handlers = ["tls", "http"]
    port = 443

[[vm]]
  size = "shared-cpu-1x"
  memory_mb = 256
```

The `auto_stop_machines = "stop"` + `min_machines_running = 0` combo is
the key to staying on Fly's free tier — the VM idles to zero when
nothing's hitting it, and cold-starts in 1–2s when our hourly Vercel
fetch arrives.

## Step 3 — Set up the session and Redis

Nitter requires Redis. The simplest way on Fly is to run Redis inside
the same container. The official `zedeus/nitter` image doesn't include
Redis by default, so we need a slightly fancier Dockerfile. Replace
the one above with:

```dockerfile
FROM zedeus/nitter:latest

# Add valkey (open-source Redis fork).
RUN apk add --no-cache valkey

# Sessions live on the persistent volume.
ENV NITTER_SESSIONS_FILE=/data/sessions.jsonl

# Start both valkey and nitter; valkey first so nitter can connect.
RUN echo '#!/bin/sh' > /entrypoint.sh && \
    echo 'valkey-server --daemonize yes --bind 127.0.0.1' >> /entrypoint.sh && \
    echo 'exec /src/nitter -c /src/nitter.conf' >> /entrypoint.sh && \
    chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
```

> If `valkey` isn't in alpine's repos when you build, swap to
> `redis` — same protocol. `apk add --no-cache redis` and use
> `redis-server --daemonize yes --bind 127.0.0.1` in the script.

Now create the volume and deploy:

```bash
fly launch --no-deploy           # creates the app, accept defaults
fly volumes create nitter_data --region iad --size 1     # 1GB, free
```

## Step 4 — Upload the burner session

Create a local file `sessions.jsonl` (one line, no trailing newline):

```jsonl
{"kind": "cookie", "username": "your-burner-handle", "id": "1234567890123456789", "auth_token": "PASTE_FROM_STEP_1", "ct0": "PASTE_FROM_STEP_1"}
```

Then copy it onto the volume. Fly has no direct `scp` to volumes, but
you can use an ephemeral machine:

```bash
fly machine run --volume nitter_data:/data alpine sh -c "cat > /data/sessions.jsonl" < sessions.jsonl
```

Verify:

```bash
fly ssh console -C "cat /data/sessions.jsonl"
```

You should see your JSON line.

## Step 5 — Deploy

```bash
fly deploy
```

Wait ~30s for the build + first boot. Then:

```bash
fly status
fly logs                              # watch for "Starting Nitter at..."
curl https://your-nitter.fly.dev/your-real-handle/rss | head -40
```

You should get back a real RSS feed with your recent tweets. If you
get a Cloudflare-style "Verifying you are human" HTML page or an
HTTP 5xx, check `fly logs` — the most common failure modes are:

| Symptom | Fix |
|---|---|
| `Could not connect to Redis` | Valkey/Redis didn't start. Check entrypoint script. |
| `No sessions in pool` | `sessions.jsonl` not on `/data`, or wrong filename. |
| `401 Unauthorized` from X | Session expired. Re-do step 1, overwrite `sessions.jsonl`. |
| Cold-start timeout | First request after idle takes 2–4s. Subsequent requests are fast. |

## Step 6 — Wire it up to the dashboard

In your **Vercel** project (the `commiter` deployment):

1. Project → Settings → Environment Variables → New
2. Key: `X_NITTER_HOST`
3. Value: `your-nitter.fly.dev` (no protocol, no slash)
4. Environments: Production, Preview, Development → Save
5. Redeploy (or push any commit).

After deploy, the build log should show:

```
[twitter] using self-hosted Nitter host=your-nitter.fly.dev for login=anishthite (items=N, in_window=M)
```

instead of the `syndication.twitter.com` fallback line. That's the
green flag.

For local dev, drop the same line into `apps/web/.env.local`.

## Maintenance

- **Session refresh** — `auth_token` rotates roughly every few months,
  or instantly if you log the burner out somewhere. When the Twitter
  panel goes silent, check `fly logs`; if you see `401 Unauthorized`,
  redo step 1 + step 4 (~5 min).
- **Cost** — Fly's free tier covers up to 3 shared-cpu-1x machines, 3GB
  of persistent volumes, and 160GB egress/month. A personal Nitter
  hitting only the dashboard's hourly fetch will use a tiny fraction.
  You will get a $0 bill.
- **Updates** — `fly deploy` again to pull a newer Nitter image
  (the zedeus team patches X API breakages roughly monthly).
- **Burner hygiene** — never tweet from the burner, never follow people
  you know, never connect a phone number. The point is for it to be
  invisible and disposable.

## References

- [zedeus/nitter — official repo](https://github.com/zedeus/nitter)
- [Creating session tokens](https://github.com/zedeus/nitter/wiki/Creating-session-tokens)
- [sekai-soft self-hosting guide (Fly.io)](https://github.com/sekai-soft/guide-nitter-self-hosting/blob/master/docs/fly-io.md)
- [Fly.io free tier](https://fly.io/docs/about/pricing/#free-allowances)

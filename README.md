# 🎵 Echo Show Spotify Dashboard

A beautiful, real-time Spotify now-playing dashboard built for Amazon Echo Show devices — synced lyrics, liked songs, queue, shuffle, weather, and more. One page and a tiny self-hosted server. No subscription.

> **Transparency note:** This entire project was built through conversation with [Claude AI](https://claude.ai) (free tier) — I prompted it, directed it, debugged it, and made every design decision. I don't write JavaScript or CSS. That's the point. If you're a recruiter: this shows I know how to use AI as a tool effectively, identify problems, and ship a working product. That's a skill in itself.

---

## 📸 Screenshots

<p align="center">
  <img src="screenshots/Screenshot 2026-03-15 at 00.46.46.png" alt="Now Playing Page" width="48%" />
  <img src="screenshots/Screenshot 2026-03-15 at 00.48.31.png" alt="Lyrics Page" width="48%" />
</p>

<p align="center">
  <em>Now Playing page (left) &nbsp;·&nbsp; Lyrics page with synced scroll (right)</em>
</p>

<p align="center">
  <img src="screenshots/now-playing.png" alt="Now Playing — Drugs N Hella Melodies" width="48%" />
  <img src="screenshots/lyrics.png" alt="Lyrics — Nights by Frank Ocean" width="48%" />
</p>

<p align="center">
  <em>Now Playing (left) &nbsp;·&nbsp; Synced lyrics view (right)</em>
</p>

---

## ✨ Features

- **Real-time playback** — polls Spotify's Web API every 1 second directly. No Home Assistant lag.
- **Synced lyrics** — fetched from [lrclib.net](https://lrclib.net) (free, no key). Active line auto-highlighted and centered.
- **Smart lyrics page** — stays on lyrics if next song has lyrics too. Auto-returns to Now Playing if none found. Toggle off with the back button.
- **Liked Songs sync** — heart auto-fills green if the song is in your Liked Songs. Tap to like or unlike. Checks every 10 seconds so changes from other devices reflect automatically.
- **Queue** — live Next Up list with artwork, pulled directly from Spotify.
- **Shuffle & Loop** — toggle from the dashboard. Synced with Spotify state.
- **Volume slider** — custom div-based (not a native `<input type="range">`) so it renders correctly on Fire OS.
- **Weather** — uses browser geolocation + [Open-Meteo](https://open-meteo.com) (free, no API key). Hides gracefully if location is denied.
- **Clock & date** — pure JS, no dependencies.
- **Touch support** — all scrubbers work with touch events for the Echo Show touchscreen.
- **Responsive queue** — adapts to any screen width.
- **Fits any Echo Show** — designed at 960×480 (Show 5) and scales to fill 1280×800 (Show 8/10) or 1920×1080 (Show 15) with no dead bands.
- **Touch gestures** — swipe the album art to skip/go back, swipe elsewhere to flip between Now Playing and Lyrics, double-tap the art to like.
- **Tap-to-seek lyrics** — tap any lyric line to jump there. Lyrics are large enough to read across the room and wrap instead of cutting off.
- **Up next** — the next track is shown under the progress bar.
- **Device picker** — tap "Now playing on …" to move playback to any Spotify Connect device.
- **Night mode** — dims the screen overnight (default 10 PM–7 AM, configurable); a tap brightens it for 30 seconds.
- **Idle clock** — after 5 minutes with nothing playing, fades to a dim, slowly drifting clock (burn-in friendly). Tap to wake.
- **Podcasts** — episodes show with show name and artwork.
- **Wakes Spotify** — if playback went idle, Play transfers back to the last device instead of failing.
- **Rate-limit aware** — adaptive polling (1s playing, slower when paused/hidden) and honors Spotify's `Retry-After`.
- **Self-updating** — kiosks reload automatically when the server's files change.

> **2026 note:** Spotify removed `/me/tracks` for development-mode apps in February 2026. Liked Songs now uses `/me/library`.

---

## 🛠 How To Set This Up At Home

### What You Need

| Thing | Cost |
|---|---|
| Amazon Echo Show (any gen) | You already have it |
| Spotify account | Free or Premium |
| Spotify Developer App | Free |
| Somewhere to host one HTML file | Free (GitHub Pages works great) |
| [FreeKiosk](https://freekiosk.app/download/) | Free |

---

### Step 1 — Sideload Apps via ADB

Echo Shows run **Fire OS** (Android). You can install apps via **ADB (Android Debug Bridge)**.

Big shoutout to the Fire OS modding community for documenting this process.

**Tools:**
- **[ADB](https://developer.android.com/tools/adb)** — works on **Windows, macOS, and Linux**
- **[scrcpy](https://github.com/Genymobile/scrcpy)** — optional but great: mirrors and controls your Echo Show from your computer

**Enable ADB on your Echo Show:**
1. Settings → Device Options → Developer Options
2. Enable ADB

**Connect from your computer:**
```bash
adb connect <your-echo-show-ip>:5555
```

**Install FreeKiosk:**
```bash
adb install freekiosk.apk
```

---

### Step 2 — Set Up FreeKiosk

[FreeKiosk](https://freekiosk.app/download/) runs as a clean full-screen browser — no address bar, no notification banners, no UI chrome.

1. Sideload it via ADB
2. Point it at your dashboard URL
3. Enable "Disable status bar" so Spotify banners don't interrupt the display

> **Note:** The dashboard also works in Silk Browser (Fire OS's built-in browser). FreeKiosk just gives the cleanest kiosk experience.

---

### Step 3 — Create a Spotify Developer App

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Create an app
3. Copy your **Client ID** and **Client Secret**
4. Under **Redirect URIs**, add your dashboard URL (e.g. `https://dash.example.com/dashboard.html`)
5. Enable **Web API** under APIs used
6. Add your Spotify email under **Users and Access** (required in Development mode)

---

### Step 4 — Configure & Run

The dashboard is now a static page plus a tiny Python server (standard library only) that keeps your Spotify **client secret off the page** — the browser never sees it.

```bash
cp .env.example .env        # fill in SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / SPOTIFY_REDIRECT_URI
docker compose up -d        # serves on 127.0.0.1:8766
```

No Docker? `set -a; . ./.env; python3 server.py` works too.

The page is served at `/dashboard.html` (and `/local/dashboard.html`, for older setups whose Spotify redirect URI points there). Your `SPOTIFY_REDIRECT_URI` must exactly match one registered on the Spotify app.

Optional: set `WEATHER_LAT` / `WEATHER_LON` in `.env` — Echo Show kiosk browsers often can't do geolocation.

---

### Step 5 — Expose It

Point a hostname at `http://localhost:8766` — e.g. a Cloudflare Tunnel public hostname. Then open it, tap **Connect Spotify**, log in, and approve. The refresh token lives in that browser's `localStorage`, so each Echo connects once.

When you update the files, open dashboards reload themselves within 5 minutes — no need to touch the Echo.

---

### Do I Need My Own Domain?

**No.** GitHub Pages is free and works perfectly. If you want to use my hosted version, just swap in your own Spotify Client ID and Secret.

---

### Multi-Echo Show Sync

Spotify Connect means any device logged into your account sees the same playback state. Run this dashboard on multiple Echo Shows and they'll all stay in sync — same song, same position, same queue — updated every 1 second via direct Spotify API.

---

## 🚫 Do I Need Home Assistant?

**No.** HA was used in early development as a Spotify proxy. v2 removed it entirely — everything goes through the Spotify Web API directly.

---

## 🙏 Credits & Tools

| | |
|---|---|
| **ADB** | [developer.android.com/tools/adb](https://developer.android.com/tools/adb) — sideload on Fire OS from Windows/macOS/Linux |
| **scrcpy** | [github.com/Genymobile/scrcpy](https://github.com/Genymobile/scrcpy) — mirror + control Echo Show from your computer |
| **FreeKiosk** | [freekiosk.app](https://freekiosk.app/download/) — full-screen kiosk browser for Echo Show |
| **lrclib.net** | Free synced lyrics API, no key needed |
| **Open-Meteo** | Free weather API, no key needed |
| **Spotify Web API** | [developer.spotify.com](https://developer.spotify.com/dashboard) |
| **Echo Show modding community** | For documenting ADB access and Fire OS sideloading |
| **Claude AI** | [claude.ai](https://claude.ai) — built this entire project through conversation (free tier) |

---

## 💬 On Using AI

I don't write JavaScript or CSS. This project was built entirely by prompting Claude AI, reviewing the output, catching bugs, making design calls, and directing what to build next. Every feature, fix, and decision went through me — Claude was the tool, I was the engineer.

I'm posting this publicly because:
1. It works really well and other Echo Show owners might want it
2. It's an honest example of what you can build with AI tools and clear thinking
3. I'd rather be transparent than have anyone think I have skills I don't

If you're a recruiter: I know how to identify a problem, use the right tool, iterate until it's right, and ship something real. That's what this is.

---

## 📄 License

MIT — use it, fork it, do whatever. A shoutout is appreciated but not required.

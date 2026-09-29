// Echo Dashboard — Spotify-style now playing + clock for Echo Show kiosks.
// All Spotify calls go straight from the browser to api.spotify.com; the local
// server only holds the client secret for token exchange/refresh.

// ── Config (filled from /api/config) ───────────────────────
let CFG = { client_id: '', redirect_uri: '', lat: null, lon: null, version: '' };
const SP_API    = 'https://api.spotify.com/v1';
// Must stay identical across versions so tokens saved on the Echo keep working.
const SP_SCOPES = 'user-read-playback-state user-read-currently-playing user-library-read user-library-modify user-modify-playback-state';
const IDLE_AFTER_MS = 5 * 60 * 1000;

// ── State ──────────────────────────────────────────────────
let isPlaying = false, isShuffle = false, isLiked = false, repeatState = 'off';
let duration = 0, position = 0, volume = 50;
let basePos = 0, baseTime = 0;           // position = basePos + time since baseTime (while playing)
let lastArt = '', lastTrack = '';
let isDragging = false, activeScrubber = 'main';
let onLyricsPage = false, queueOpen = false, userRequestedLyrics = false;
let currentTrackId = null, currentItemType = 'track';
let controlLockUntil = 0;                // ignore polled play/shuffle/repeat right after a tap
let idleSince = Date.now(), idleShown = false;

const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

function fmt(s) {
  s = Math.floor(s || 0);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function setStatus(ok) { $('status-dot').classList.toggle('show', !ok); }

// ── Icons ──────────────────────────────────────────────────
const ICON_PLAY  = '<path d="M8 5v14l11-7z"/>';
const ICON_PAUSE = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
const ICON_ADD   = '<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 7.5v9M7.5 12h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>';
const ICON_ADDED = '<circle cx="12" cy="12" r="10.5" fill="#1ed760"/><path d="M7.3 12.4l3.1 3.1 6.3-6.6" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
const ICON_SPEAKER = '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M17 2H7c-1.1 0-2 .9-2 2v16c0 1.1.9 1.99 2 1.99L17 22c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-5 2c1.1 0 2 .9 2 2s-.9 2-2 2c-1.11 0-2-.9-2-2s.89-2 2-2zm0 16c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>';

// ── Page switching ─────────────────────────────────────────
function goToLyrics() {
  userRequestedLyrics = true;
  onLyricsPage = true;
  $('page-main').classList.remove('active');
  $('page-lyrics').classList.add('active');
  currentLyricIdx = -2;
  syncLyrics(position, true);
}
function goToMain() {
  userRequestedLyrics = false;
  onLyricsPage = false;
  $('page-lyrics').classList.remove('active');
  $('page-main').classList.add('active');
}

function setDeviceLabel(name) {
  ['device-label', 'device-label-lyrics'].forEach(id => {
    const el = $(id);
    if (!name) { el.innerHTML = ''; return; }
    el.innerHTML = ICON_SPEAKER;
    el.append(' ' + name);
  });
}

// ── Smooth progress (requestAnimationFrame + transforms, no stepping) ──
function currentPos() {
  if (!isPlaying) return basePos;
  return Math.min(basePos + (performance.now() - baseTime) / 1000, duration || Infinity);
}
function setBase(p) { basePos = p; baseTime = performance.now(); position = p; }

const shownTimes = {};
function renderProgress(pos, dur) {
  const pct = dur > 0 ? Math.max(0, Math.min(pos / dur, 1)) : 0;
  ['main', 'lyrics'].forEach(id => {
    $('fill-' + id).style.transform = 'scaleX(' + pct + ')';
    $('rail-' + id).style.transform = 'translateX(' + (pct * 100) + '%)';
    const p = fmt(pos), d = fmt(dur);
    if (shownTimes['p' + id] !== p) { $('pos-' + id).textContent = p; shownTimes['p' + id] = p; }
    if (shownTimes['d' + id] !== d) { $('dur-' + id).textContent = d; shownTimes['d' + id] = d; }
  });
}
function frame() {
  if (!isDragging && !document.hidden && !idleShown) {
    position = currentPos();
    renderProgress(position, duration);
    if (onLyricsPage) syncLyrics(position);
  }
  requestAnimationFrame(frame);
}

// ── Spotify auth ───────────────────────────────────────────
let spAccessToken  = localStorage.getItem('sp_access_token')  || null;
let spRefreshToken = localStorage.getItem('sp_refresh_token') || null;
let spTokenExpiry  = parseInt(localStorage.getItem('sp_token_expiry') || '0');
if ((localStorage.getItem('sp_scopes') || '') !== SP_SCOPES) clearSpotifyTokens();

function clearSpotifyTokens() {
  spAccessToken = spRefreshToken = null; spTokenExpiry = 0;
  ['sp_access_token', 'sp_refresh_token', 'sp_token_expiry'].forEach(k => localStorage.removeItem(k));
}
function isConnected() { return !!(spAccessToken || spRefreshToken); }
function showConnectButton() {
  $('sp-connect-btn').style.display = isConnected() ? 'none' : 'flex';
  $('lyrics-btn-main').parentNode.style.display = isConnected() ? 'flex' : 'none';
}

function startSpotifyOAuth() {
  const state = Math.random().toString(36).slice(2);
  localStorage.setItem('sp_oauth_state', state);
  const params = new URLSearchParams({
    client_id: CFG.client_id, response_type: 'code',
    redirect_uri: CFG.redirect_uri, scope: SP_SCOPES, state
  });
  window.location.href = 'https://accounts.spotify.com/authorize?' + params;
}

async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code'), state = params.get('state');
  if (code && state === localStorage.getItem('sp_oauth_state')) {
    const r = await fetch('/api/spotify/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    if (r.ok) saveSpotifyTokens(await r.json());
    localStorage.removeItem('sp_oauth_state');
  }
  // Spotify redirects to /local/dashboard.html, the refresh button adds ?_= — land back on the clean kiosk URL.
  if (window.location.search || window.location.pathname !== '/dashboard.html') {
    window.history.replaceState({}, '', '/dashboard.html');
  }
}

let refreshInFlight = null;
function refreshSpotifyToken() {
  if (!spRefreshToken) return Promise.resolve(false);
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const r = await fetch('/api/spotify/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: spRefreshToken })
      });
      if (r.ok) { saveSpotifyTokens(await r.json()); return true; }
      // 400 invalid_grant = refresh token revoked → need to reconnect
      if (r.status === 400) { clearSpotifyTokens(); showConnectButton(); }
      return false;
    } catch (e) { return false; }
    finally { refreshInFlight = null; }
  })();
  return refreshInFlight;
}

function saveSpotifyTokens(d) {
  spAccessToken = d.access_token;
  if (d.refresh_token) spRefreshToken = d.refresh_token;
  spTokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
  localStorage.setItem('sp_access_token',  spAccessToken);
  localStorage.setItem('sp_refresh_token', spRefreshToken);
  localStorage.setItem('sp_token_expiry',  spTokenExpiry);
  localStorage.setItem('sp_scopes',        SP_SCOPES);
  showConnectButton();
}

// Returns { ok, status, data }. Handles expiry, 401 retry, 429 backoff, empty bodies.
let rateLimitedUntil = 0;
async function sp(path, method = 'GET', body = null, retried = false) {
  if (!isConnected()) return { ok: false, status: 0 };
  if (Date.now() < rateLimitedUntil) return { ok: false, status: 429 };
  if (!spAccessToken || Date.now() > spTokenExpiry) {
    if (!(await refreshSpotifyToken())) return { ok: false, status: 401 };
  }
  const opts = { method, headers: { 'Authorization': 'Bearer ' + spAccessToken } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let r;
  try { r = await fetch(SP_API + path, opts); }
  catch (e) { setStatus(false); return { ok: false, status: 0 }; }
  setStatus(true);
  if (r.status === 401 && !retried) {
    if (await refreshSpotifyToken()) return sp(path, method, body, true);
    return { ok: false, status: 401 };
  }
  if (r.status === 429) {
    const wait = parseInt(r.headers.get('Retry-After') || '5');
    rateLimitedUntil = Date.now() + Math.min(wait, 120) * 1000;
    return { ok: false, status: 429 };
  }
  const text = await r.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) {} }
  return { ok: r.ok, status: r.status, data };
}

// Normalises tracks and podcast episodes into one shape.
function itemInfo(item) {
  if (!item) return { name: '', artist: '', album: '', art: '', artSmall: '' };
  const imgs = item.type === 'episode' ? (item.images?.length ? item.images : item.show?.images || []) : (item.album?.images || []);
  const base = {
    name: item.name || '',
    art: imgs[0]?.url || '',
    artSmall: imgs[imgs.length - 1]?.url || ''
  };
  if (item.type === 'episode') {
    return Object.assign(base, { artist: item.show?.publisher || item.show?.name || '', album: item.show?.name || '' });
  }
  return Object.assign(base, {
    artist: item.artists?.map(a => a.name).join(', ') || '',
    firstArtist: item.artists?.[0]?.name || '',
    album: item.album?.name || ''
  });
}

// ── Side panel (queue or device picker) ────────────────────
let panelMode = null;
function openPanel(mode) {
  panelMode = mode;
  queueOpen = true;
  $('panel-title').textContent = mode === 'devices' ? 'Connect to a device' : 'Queue';
  $('queue-list').innerHTML = '';
  $('queue-panel').classList.add('open');
  $('queue-backdrop').classList.add('open');
  $$('.queue-btn').forEach(b => b.classList.toggle('active', mode === 'queue'));
  if (mode === 'devices') fetchDevices(); else fetchQueue();
}
function closePanel() {
  panelMode = null;
  queueOpen = false;
  $('queue-panel').classList.remove('open');
  $('queue-backdrop').classList.remove('open');
  $$('.queue-btn').forEach(b => b.classList.remove('active'));
}
function toggleQueue() { if (panelMode === 'queue') closePanel(); else openPanel('queue'); }
function openDevices() { if (isConnected()) openPanel('devices'); }

function panelMessage(text) {
  const m = document.createElement('div');
  m.className = 'q-msg';
  m.textContent = text;
  $('queue-list').innerHTML = '';
  $('queue-list').appendChild(m);
}

async function fetchQueue() {
  if (!isConnected()) return panelMessage('Connect Spotify to see your queue.');
  if (!$('queue-list').children.length) panelMessage('Loading…');
  const r = await sp('/me/player/queue');
  if (r.ok && r.data) renderQueue(r.data);
  else panelMessage('Couldn’t load the queue.');
}

function queueRow(item, isCurrent) {
  const info = itemInfo(item);
  const div = document.createElement('div');
  div.className = 'queue-item';
  const artBox = document.createElement('div');
  artBox.className = 'queue-item-art';
  if (info.artSmall) { const img = document.createElement('img'); img.src = info.artSmall; artBox.appendChild(img); }
  const txt = document.createElement('div');
  txt.className = 'queue-item-info';
  const t = document.createElement('div');
  t.className = 'queue-item-title' + (isCurrent ? ' queue-now' : '');
  t.textContent = info.name;
  const a = document.createElement('div');
  a.className = 'queue-item-artist';
  a.textContent = info.artist;
  txt.append(t, a);
  div.append(artBox, txt);
  return div;
}

function renderQueue(data) {
  const list = $('queue-list');
  list.innerHTML = '';
  const head = text => { const h = document.createElement('div'); h.className = 'q-head'; h.textContent = text; list.appendChild(h); };
  if (data.currently_playing) { head('Now playing'); list.appendChild(queueRow(data.currently_playing, true)); }
  if (data.queue?.length) { head('Next up'); data.queue.slice(0, 20).forEach(t => list.appendChild(queueRow(t, false))); }
  if (!data.currently_playing && !data.queue?.length) panelMessage('Queue is empty.');
}

const DEVICE_ICON = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 6h18V4H4c-1.1 0-2 .9-2 2v11H0v3h14v-3H4V6zm19 2h-6c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V9c0-.55-.45-1-1-1zm-1 9h-4v-7h4v7z"/></svg>';
async function fetchDevices() {
  panelMessage('Looking for devices…');
  const r = await sp('/me/player/devices');
  const devices = r.data?.devices || [];
  if (!r.ok || !devices.length) return panelMessage('No devices found. Open Spotify on a device first.');
  const list = $('queue-list');
  list.innerHTML = '';
  devices.forEach(d => {
    const row = document.createElement('div');
    row.className = 'device-row' + (d.is_active ? ' current' : '');
    row.innerHTML = DEVICE_ICON;
    const box = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'dev-name';
    name.textContent = d.name;
    const type = document.createElement('div');
    type.className = 'dev-type';
    type.textContent = d.is_active ? 'Listening on this device' : (d.type || '').toLowerCase();
    box.append(name, type);
    row.appendChild(box);
    row.onclick = async () => {
      closePanel();
      await sp('/me/player', 'PUT', { device_ids: [d.id], play: true });
      pollSoon(500, 1500, 3000);
    };
    list.appendChild(row);
  });
}

// "Next in queue" card under the album art — one queue call per track change.
async function updateUpNext() {
  const r = await sp('/me/player/queue');
  const next = r.ok ? r.data?.queue?.[0] : null;
  const card = $('next-card');
  if (!next) { card.classList.add('empty'); return; }
  const info = itemInfo(next);
  const title = $('up-next');
  title.textContent = info.name;
  if (info.artist) { const s = document.createElement('span'); s.textContent = ' · ' + info.artist; title.appendChild(s); }
  const art = $('next-art');
  art.innerHTML = '';
  if (info.artSmall) { const img = document.createElement('img'); img.src = info.artSmall; art.appendChild(img); }
  card.classList.remove('empty');
}

// ── Clock (ticks exactly on the second) ────────────────────
const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function updateClock() {
  const now = new Date();
  let h = now.getHours();
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const date = DAYS[now.getDay()] + ', ' + MONTHS[now.getMonth()] + ' ' + now.getDate();
  $('time-hm').textContent = h + ':' + m;
  $('time-s').textContent = s;
  $('time-ampm').textContent = ampm;
  $('date').textContent = date;
  $('lyr-time').innerHTML = h + ':' + m + '<span>:' + s + ' ' + ampm + '</span>';
  $('idle-time').innerHTML = '<span class="i-hm">' + h + ':' + m + '</span><span class="i-side"><span class="i-s">' + s + '</span><span class="i-ampm">' + ampm + '</span></span>';
  $('idle-date').textContent = date;
}
function clockTick() {
  updateClock();
  setTimeout(clockTick, 1000 - (Date.now() % 1000) + 15);
}

// ── Weather (Open-Meteo, no key) ───────────────────────────
const WMO_CODE = {
  0:'☀️',1:'🌤️',2:'⛅',3:'☁️',45:'🌫️',48:'🌫️',
  51:'🌦️',53:'🌦️',55:'🌧️',61:'🌧️',63:'🌧️',65:'🌧️',
  71:'❄️',73:'❄️',75:'❄️',77:'🌨️',80:'🌦️',81:'🌧️',
  82:'🌧️',85:'❄️',86:'❄️',95:'⛈️',96:'⛈️',99:'⛈️'
};
const WMO_DESC = {
  0:'Clear',1:'Mostly clear',2:'Partly cloudy',3:'Overcast',
  45:'Foggy',48:'Foggy',51:'Light drizzle',53:'Drizzle',55:'Heavy drizzle',
  61:'Light rain',63:'Rain',65:'Heavy rain',71:'Light snow',73:'Snow',
  75:'Heavy snow',77:'Snow grains',80:'Rain showers',81:'Rain showers',
  82:'Heavy showers',85:'Snow showers',86:'Heavy snow showers',
  95:'Thunderstorm',96:'Thunderstorm',99:'Thunderstorm'
};

// Coordinates: server config (WEATHER_LAT/LON) wins, then browser geolocation, then last known.
function getCoords() {
  if (CFG.lat != null && CFG.lon != null) return Promise.resolve({ lat: CFG.lat, lon: CFG.lon });
  const saved = JSON.parse(localStorage.getItem('weather_coords') || 'null');
  if (!navigator.geolocation) return Promise.resolve(saved);
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(pos => {
      const c = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      localStorage.setItem('weather_coords', JSON.stringify(c));
      resolve(c);
    }, () => resolve(saved), { timeout: 8000, maximumAge: 3600000 });
  });
}

async function updateWeather() {
  const c = await getCoords();
  if (!c) return;
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}` +
                          `&current=temperature_2m,weather_code&temperature_unit=fahrenheit`);
    const d = await r.json();
    const t = Math.round(d.current.temperature_2m), wmo = d.current.weather_code;
    $('w-icon').textContent = WMO_CODE[wmo] || '';
    $('w-temp').textContent = t + '°';
    $('w-desc').textContent = WMO_DESC[wmo] || '';
    $('idle-weather').textContent = (WMO_CODE[wmo] || '') + ' ' + t + '°F · ' + (WMO_DESC[wmo] || '');
  } catch (e) {}
}

// ── Album colour (Spotify-style background) ────────────────
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  if (!s) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { t = (t + 1) % 1; return t < 1/6 ? p + (q - p) * 6 * t : t < 1/2 ? q : t < 2/3 ? p + (q - p) * (2/3 - t) * 6 : p; };
  return [f(h + 1/3), f(h), f(h - 1/3)].map(v => Math.round(v * 255));
}
function albumColour(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 24, 24);
        const d = ctx.getImageData(0, 0, 24, 24).data;
        let r = 0, g = 0, b = 0, w = 0;
        for (let i = 0; i < d.length; i += 4) {
          const [, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
          // favour vivid mid-tones over near-black/near-white pixels
          const wt = 0.06 + s * s * Math.max(0, 1 - Math.abs(l - 0.5) * 1.6);
          r += d[i] * wt; g += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
        }
        resolve(rgbToHsl(r / w, g / w, b / w));
      } catch (e) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
async function applyAlbumColour(url, trackId) {
  const hsl = url ? await albumColour(url) : null;
  if (trackId !== currentTrackId) return;
  let [h, s, l] = hsl || [0, 0, 0.3];
  if (s > 0.12) s = Math.min(Math.max(s, 0.45), 0.8);
  const main = hslToRgb(h, s, Math.min(Math.max(l, 0.3), 0.42));
  const ly   = hslToRgb(h, s, Math.min(Math.max(l, 0.36), 0.44));
  $('stage').style.setProperty('--accent', main.join(', '));
  $('stage').style.setProperty('--ly', ly.join(', '));
}

// ── UI sync helpers ────────────────────────────────────────
function applyPlayUI() { $$('.play-icon').forEach(el => { el.innerHTML = isPlaying ? ICON_PAUSE : ICON_PLAY; }); }
function applyShuffleUI() { $$('.shuffle-btn').forEach(el => el.classList.toggle('on', isShuffle)); }
function applyLoopUI() {
  $$('.loop-btn').forEach(el => {
    el.classList.toggle('on', repeatState !== 'off');
    el.classList.toggle('loop-one', repeatState === 'track');
  });
}
function applyLikeUI() {
  const show = currentItemType === 'track' && !!currentTrackId;
  ['like-btn-main', 'like-btn-lyrics'].forEach(id => {
    const b = $(id);
    b.style.visibility = show ? 'visible' : 'hidden';
    const size = id === 'like-btn-main' ? 30 : 22;
    b.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24">${isLiked ? ICON_ADDED : ICON_ADD}</svg>`;
  });
}

function setArt(url) {
  ['art-wrap', 'art-wrap-lyrics'].forEach(id => {
    const img = document.createElement('img');
    img.style.opacity = '0';
    img.onload = () => { img.style.opacity = '1'; };
    img.src = url;
    $(id).innerHTML = '';
    $(id).appendChild(img);
  });
}

function setTrackText(info) {
  const name = $('track-name');
  name.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = info.name;
  name.appendChild(span);
  // Spotify-style marquee for titles that don't fit
  requestAnimationFrame(() => {
    const over = span.scrollWidth - name.clientWidth;
    if (over > 4) {
      name.style.setProperty('--dist', -(over + 12) + 'px');
      name.style.setProperty('--dur', Math.max(10, over / 18) + 's');
      span.classList.add('scroll');
    }
  });
  $('track-meta').textContent = info.artist + (info.album && info.album !== info.name ? ' · ' + info.album : '');
  $('lyr-track-name').textContent = info.name;
  $('lyr-meta-row').textContent = info.artist;
}

function showNothingPlaying() {
  $('track-name').innerHTML = '<span class="not-playing">' + (isConnected() ? 'Nothing playing' : 'Connect Spotify to get started') + '</span>';
  $('track-meta').textContent = isConnected() ? 'Play something on Spotify' : '';
  $('lyr-track-name').textContent = 'Nothing playing';
  $('lyr-meta-row').textContent = '';
  $('next-card').classList.add('empty');
  setDeviceLabel('');
  lyricsLines = [];
  lastTrack = '';
  currentTrackId = null;
  isPlaying = false;
  applyPlayUI();
  applyLikeUI();
  setBase(0);
  duration = 0;
}

// ── Controls ───────────────────────────────────────────────
function lockControls() { controlLockUntil = Date.now() + 1500; }
function pollSoon(...delays) { delays.forEach(d => setTimeout(updateFromSpotify, d)); }

async function togglePlay() {
  wakeFromIdle();
  const p = currentPos();
  isPlaying = !isPlaying; setBase(p); applyPlayUI(); lockControls();
  let r = await sp(`/me/player/${isPlaying ? 'play' : 'pause'}`, 'PUT');
  // No active device (Spotify went idle) → wake the last device we saw.
  if (!r.ok && r.status === 404 && isPlaying) {
    const dev = localStorage.getItem('sp_last_device');
    if (dev) r = await sp('/me/player', 'PUT', { device_ids: [dev], play: true });
  }
  if (!r.ok) controlLockUntil = 0;
  pollSoon(400, 1200);
}
async function nextTrack() {
  await sp('/me/player/next', 'POST');
  pollSoon(250, 700, 1500);
}
async function prevTrack() {
  // Like Spotify: more than 3s in → restart the song, otherwise go to the previous one.
  if (currentPos() > 3) return seekTo(0);
  await sp('/me/player/previous', 'POST');
  pollSoon(250, 700, 1500);
}
async function toggleShuffle() {
  isShuffle = !isShuffle; applyShuffleUI(); lockControls();
  await sp(`/me/player/shuffle?state=${isShuffle}`, 'PUT');
  setTimeout(updateUpNext, 800);
}
async function toggleLoop() {
  repeatState = { off: 'context', context: 'track', track: 'off' }[repeatState] || 'off';
  applyLoopUI(); lockControls();
  await sp(`/me/player/repeat?state=${repeatState}`, 'PUT');
}
async function seekTo(sec) {
  setBase(Math.max(0, Math.min(sec, duration)));
  currentLyricIdx = -2;
  renderProgress(position, duration);
  if (onLyricsPage) syncLyrics(position, true);
  await sp(`/me/player/seek?position_ms=${Math.floor(position * 1000)}`, 'PUT');
}

// Liked Songs — Spotify replaced /me/tracks with /me/library in Feb 2026.
let lastLikeCheck = 0, likeLockUntil = 0;
async function checkIfLiked(trackId, force = false) {
  if (!trackId || currentItemType !== 'track') return;
  const now = Date.now();
  if (!force && (now - lastLikeCheck < 10000 || now < likeLockUntil)) return;
  lastLikeCheck = now;
  const r = await sp('/me/library/contains?uris=' + encodeURIComponent('spotify:track:' + trackId));
  if (r.ok && Array.isArray(r.data) && trackId === currentTrackId && Date.now() >= likeLockUntil) {
    isLiked = r.data[0] === true;
    applyLikeUI();
  }
}
async function toggleLike() {
  if (!currentTrackId || currentItemType !== 'track') return;
  isLiked = !isLiked; applyLikeUI();
  likeLockUntil = Date.now() + 3000;
  const r = await sp('/me/library?uris=' + encodeURIComponent('spotify:track:' + currentTrackId), isLiked ? 'PUT' : 'DELETE');
  if (!r.ok) { isLiked = !isLiked; applyLikeUI(); likeLockUntil = 0; }
}

// ── Volume sheet ───────────────────────────────────────────
let volOpen = false, volCloseTimer = null;
function toggleVol() {
  volOpen = !volOpen;
  $('vol-sheet').classList.toggle('open', volOpen);
  $$('.vol-btn').forEach(b => b.classList.toggle('active', volOpen));
  if (volOpen) armVolAutoClose();
}
function armVolAutoClose() {
  clearTimeout(volCloseTimer);
  volCloseTimer = setTimeout(() => {
    if (volDragging) return armVolAutoClose();
    if (volOpen) toggleVol();
  }, 4000);
}
function updateVolSlider(val) {
  const pct = Math.max(0, Math.min(100, val)) / 100;
  $('vol-fill').style.transform = 'scaleX(' + pct + ')';
  $('vol-rail').style.transform = 'translateX(' + (pct * 100) + '%)';
  $('vol-pct').textContent = Math.round(pct * 100);
}

let volDragging = false, volTimer = null, volLockUntil = 0;
function getClientX(e) {
  return e.touches?.length ? e.touches[0].clientX : (e.changedTouches?.length ? e.changedTouches[0].clientX : e.clientX);
}
function volScrubStart(e) {
  e.preventDefault();
  volDragging = true;
  $('vol-track').classList.add('dragging');
  volApply(e);
}
function volApply(e) {
  const rect = $('vol-track').getBoundingClientRect();
  volume = Math.round(Math.max(0, Math.min(1, (getClientX(e) - rect.left) / rect.width)) * 100);
  updateVolSlider(volume);
  volLockUntil = Date.now() + 2500;
  armVolAutoClose();
  clearTimeout(volTimer);
  volTimer = setTimeout(() => sp(`/me/player/volume?volume_percent=${volume}`, 'PUT'), 250);
}
function volScrubEnd() { volDragging = false; $('vol-track').classList.remove('dragging'); }

// ── Seek scrubber ──────────────────────────────────────────
function scrubPct(e) {
  const rect = $('scrubber-' + activeScrubber).getBoundingClientRect();
  return Math.max(0, Math.min(1, (getClientX(e) - rect.left) / rect.width));
}
function scrubStart(e, which) {
  e.preventDefault();
  activeScrubber = which; isDragging = true;
  $('scrubber-' + which).classList.add('dragging');
  scrubApply(e);
}
function scrubApply(e) { renderProgress(scrubPct(e) * duration, duration); }
async function scrubEnd(e) {
  if (!isDragging) return;
  const pct = scrubPct(e);
  $('scrubber-' + activeScrubber).classList.remove('dragging');
  isDragging = false;
  await seekTo(pct * duration);
}

document.addEventListener('mousemove', e => { if (isDragging) scrubApply(e); if (volDragging) volApply(e); });
document.addEventListener('mouseup',   e => { if (isDragging) scrubEnd(e);   if (volDragging) volScrubEnd(e); });
document.addEventListener('touchmove', e => {
  if (isDragging)  { e.preventDefault(); scrubApply(e); }
  if (volDragging) { e.preventDefault(); volApply(e); }
}, { passive: false });
document.addEventListener('touchend',  e => { if (isDragging) scrubEnd(e); if (volDragging) volScrubEnd(e); });

// ── Lyrics (lrclib.net) ────────────────────────────────────
let lyricsLines = [], currentLyricIdx = -2;
const lyricsCache = new Map();   // trackId → { synced: [...] } | { plain: [...] } | null

function parseLrc(lrc) {
  const out = [];
  lrc.split('\n').forEach(line => {
    // A line can carry several timestamps: [00:12.30][01:40.10]text
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const text = line.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '').trim();
    if (!text) return;
    stamps.forEach(m => out.push({ time: parseInt(m[1]) * 60 + parseFloat(m[2]), text }));
  });
  return out.sort((a, b) => a.time - b.time);
}

async function lookupLyrics(title, artist, album, dur) {
  const toResult = d => d?.syncedLyrics ? { synced: parseLrc(d.syncedLyrics) }
                      : d?.plainLyrics  ? { plain: d.plainLyrics.split('\n').filter(l => l.trim()) } : null;
  try {
    const p = new URLSearchParams({ track_name: title, artist_name: artist });
    if (album) p.set('album_name', album);
    if (dur)   p.set('duration', dur);
    const r = await fetch('https://lrclib.net/api/get?' + p);
    if (r.ok) { const res = toResult(await r.json()); if (res) return res; }
  } catch (e) {}
  // Exact match failed (album/duration mismatch is common) → fuzzy search, prefer synced + close duration.
  try {
    const r = await fetch('https://lrclib.net/api/search?' + new URLSearchParams({ track_name: title, artist_name: artist }));
    if (!r.ok) return null;
    const hits = await r.json();
    const close = h => !dur || Math.abs((h.duration || 0) - dur) <= 4;
    const best = hits.find(h => h.syncedLyrics && close(h)) || hits.find(h => h.syncedLyrics) || hits.find(h => h.plainLyrics);
    return toResult(best);
  } catch (e) { return null; }
}

async function fetchLyrics(trackId, title, artist, album, dur) {
  lyricsLines = []; currentLyricIdx = -2;
  const inner = $('lyrics-inner');
  if (!title) return;
  let res;
  if (lyricsCache.has(trackId)) res = lyricsCache.get(trackId);
  else {
    inner.innerHTML = '<div class="lyrics-status-msg">Loading lyrics…</div>';
    res = await lookupLyrics(title, artist, album, dur);
    lyricsCache.set(trackId, res);
    if (lyricsCache.size > 200) lyricsCache.delete(lyricsCache.keys().next().value);
  }
  if (trackId !== currentTrackId) return;  // song changed while we were fetching

  inner.innerHTML = '';
  if (res?.synced?.length) {
    lyricsLines = res.synced;
    lyricsLines.forEach((line, i) => {
      const el = document.createElement('div');
      el.className = 'lyric-line'; el.id = 'lyric-' + i; el.textContent = line.text;
      el.onclick = () => seekTo(line.time);   // tap a line to jump there
      inner.appendChild(el);
    });
    if (userRequestedLyrics && !onLyricsPage) goToLyrics();
    syncLyrics(position, true);
  } else if (res?.plain?.length) {
    res.plain.forEach(text => {
      const el = document.createElement('div');
      el.className = 'lyric-line plain'; el.textContent = text;
      inner.appendChild(el);
    });
    inner.scrollTop = 0;
  } else {
    inner.innerHTML = '<div class="lyrics-status-msg">No lyrics for this one.</div>';
    // Bounce back to Now Playing, but remember the user wants lyrics for the next song.
    if (onLyricsPage) setTimeout(() => {
      if (!lyricsLines.length && onLyricsPage) {
        const keep = userRequestedLyrics;
        goToMain();
        userRequestedLyrics = keep;
      }
    }, 1500);
  }
}

// Spotify-style: sung lines light, current line white, upcoming lines dark.
function syncLyrics(pos, force) {
  if (!lyricsLines.length) return;
  let idx = -1;
  for (let i = 0; i < lyricsLines.length; i++) {
    if (lyricsLines[i].time <= pos + 0.15) idx = i; else break;
  }
  if (idx === currentLyricIdx && !force) return;
  currentLyricIdx = idx;
  for (let i = 0; i < lyricsLines.length; i++) {
    const el = $('lyric-' + i);
    if (el) el.className = 'lyric-line' + (i < idx ? ' past' : i === idx ? ' active' : '');
  }
  const inner = $('lyrics-inner');
  const active = $('lyric-' + Math.max(idx, 0));
  if (!inner || !active) return;
  const target = active.offsetTop - inner.clientHeight * 0.36;
  inner.scrollTo({ top: Math.max(0, target), behavior: force ? 'auto' : 'smooth' });
}

// ── Idle clock (nothing playing for 5 min) ─────────────────
function updateIdle() {
  if (isPlaying || queueOpen || isDragging) idleSince = Date.now();
  const shouldShow = Date.now() - idleSince > IDLE_AFTER_MS;
  if (shouldShow !== idleShown) {
    idleShown = shouldShow;
    $('idle').classList.toggle('show', shouldShow);
    document.body.classList.toggle('idle', shouldShow);
    if (shouldShow) { closePanel(); if (volOpen) toggleVol(); }
  }
  if (idleShown) {
    // drift a little every minute so nothing sits on the same pixels all night
    const n = Math.floor(Date.now() / 60000);
    $('idle-inner').style.transform = `translate(${(n * 37) % 80 - 40}px, ${(n * 23) % 50 - 25}px)`;
  }
}
function wakeFromIdle() {
  idleSince = Date.now();
  updateIdle();
}
document.addEventListener('touchstart', () => { if (!idleShown) idleSince = Date.now(); }, { passive: true });
document.addEventListener('mousedown',  () => { if (!idleShown) idleSince = Date.now(); });

// ── Spotify poller ─────────────────────────────────────────
let pollInFlight = false;
async function updateFromSpotify() {
  if (isDragging || pollInFlight) return;
  if (!isConnected()) { showNothingPlaying(); return; }
  pollInFlight = true;
  try {
    const r = await sp('/me/player?additional_types=episode');
    if (!r.ok) return;                                   // network / rate limit: keep current UI
    const data = r.data;
    if (!data || !data.item) { showNothingPlaying(); return; }   // 204 = no active session

    const item = data.item;
    const info = itemInfo(item);
    const newPos = (data.progress_ms || 0) / 1000;

    if (data.device?.id) localStorage.setItem('sp_last_device', data.device.id);
    setDeviceLabel(data.device?.name || '');

    let playChanged = false;
    if (Date.now() >= controlLockUntil) {
      playChanged = isPlaying !== !!data.is_playing;
      isPlaying = !!data.is_playing;
      isShuffle = !!data.shuffle_state;
      repeatState = data.repeat_state || 'off';
      applyPlayUI(); applyShuffleUI(); applyLoopUI();
    }
    const newVol = data.device?.volume_percent;
    if (newVol != null && newVol !== volume && Date.now() >= volLockUntil && !volDragging) {
      volume = newVol; updateVolSlider(volume);
    }

    duration = (item.duration_ms || 0) / 1000;
    const isNewTrack = item.id !== lastTrack;
    if (isNewTrack) {
      lastTrack = item.id;
      currentTrackId = item.id;
      currentItemType = item.type || 'track';
      isLiked = false; likeLockUntil = 0; applyLikeUI();
      currentLyricIdx = -2;
      checkIfLiked(item.id, true);
      setTrackText(info);
      if (info.art && info.art !== lastArt) { lastArt = info.art; setArt(info.art); }
      applyAlbumColour(info.artSmall || info.art, item.id);
      if (currentItemType === 'track') {
        fetchLyrics(item.id, info.name, info.firstArtist || info.artist, info.album, Math.round(duration));
      } else {
        lyricsLines = [];
        $('lyrics-inner').innerHTML = '<div class="lyrics-status-msg">No lyrics for podcasts.</div>';
      }
      if (panelMode === 'queue') fetchQueue();
      updateUpNext();
      wakeFromIdle();
    }

    // Only re-anchor the smooth ticker when it drifts, so the bar never jumps backwards.
    if (!isDragging && (isNewTrack || playChanged || Math.abs(currentPos() - newPos) > 1.2)) setBase(newPos);
    if (!isNewTrack) checkIfLiked(currentTrackId);
  } finally {
    pollInFlight = false;
  }
}

// Adaptive polling: fast while playing and visible, slower otherwise.
function nextPollDelay() {
  if (document.hidden) return 15000;
  if (!isConnected()) return 10000;
  if (idleShown) return 5000;
  return isPlaying ? 1000 : 3000;
}
async function pollLoop() {
  await updateFromSpotify();
  updateIdle();                 // music starting again wakes the clock screen right away
  setTimeout(pollLoop, Math.max(nextPollDelay(), rateLimitedUntil - Date.now()));
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateFromSpotify(); });

// ── Self-update: reload when the server has a new version (kiosk never needs touching) ──
async function checkVersion() {
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    const c = await r.json();
    if (CFG.version && c.version && c.version !== CFG.version) location.reload();
    setStatus(true);
  } catch (e) {}
}

// ── Fit to screen ──────────────────────────────────────────
// Designed at 960×480 (Echo Show 5); scales to fill any Echo, stretching height to the aspect ratio.
function fitStage() {
  const W = window.innerWidth, H = window.innerHeight;
  const scale = Math.min(W / 960, H / 480);
  const stage = $('stage');
  stage.style.width = Math.ceil(W / scale) + 'px';
  stage.style.height = Math.ceil(H / scale) + 'px';
  stage.style.setProperty('--h', (H / scale) + 'px');
  stage.style.transform = `scale(${scale})`;
}
window.addEventListener('resize', fitStage);
window.addEventListener('orientationchange', () => setTimeout(fitStage, 300));

// ── Touch gestures ─────────────────────────────────────────
// Swipe album art: next / previous. Swipe elsewhere: Now Playing ↔ Lyrics. Double-tap art: add to Liked Songs.
let touch0 = null, lastArtTap = 0;
function inArt(el) { return el && el.closest && el.closest('#art-wrap, #art-wrap-lyrics'); }

document.addEventListener('touchstart', e => {
  const t = e.touches[0];
  touch0 = (e.touches.length === 1) ? { x: t.clientX, y: t.clientY, time: Date.now(), target: e.target } : null;
}, { passive: true });

document.addEventListener('touchend', e => {
  if (!touch0 || isDragging || volDragging || queueOpen || idleShown) { touch0 = null; return; }
  const t = e.changedTouches[0];
  const dx = t.clientX - touch0.x, dy = t.clientY - touch0.y;
  const art = inArt(touch0.target);
  const quick = Date.now() - touch0.time < 600;
  touch0 = null;
  if (quick && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    if (art) { dx < 0 ? nextTrack() : prevTrack(); }
    else if (dx < 0 && !onLyricsPage) goToLyrics();
    else if (dx > 0 && onLyricsPage) goToMain();
    return;
  }
  if (art && Math.abs(dx) < 12 && Math.abs(dy) < 12) {
    if (Date.now() - lastArtTap < 350) { lastArtTap = 0; likeFromArt(art); }
    else lastArtTap = Date.now();
  }
});
document.addEventListener('dblclick', e => { const art = inArt(e.target); if (art) likeFromArt(art); });

function likeFromArt(artEl) {
  if (currentItemType !== 'track' || !currentTrackId) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'like-pop');
  svg.innerHTML = ICON_ADDED;
  artEl.appendChild(svg);
  setTimeout(() => svg.remove(), 1000);
  if (!isLiked) toggleLike();          // double-tap only ever adds, never removes
}

// ── Night dimming ──────────────────────────────────────────
// Between NIGHT_START and NIGHT_END (server config) the whole screen dims; a tap brightens it for 30s.
let nightWakeUntil = 0;
function isNight() {
  const s = CFG.night_start, e = CFG.night_end;
  if (s == null || e == null || s === e) return false;
  const now = new Date();
  const h = now.getHours() + now.getMinutes() / 60;
  return s < e ? (h >= s && h < e) : (h >= s || h < e);
}
function updateNight() {
  document.body.classList.toggle('night', isNight());
  const dim = isNight() && Date.now() > nightWakeUntil;
  $('night').style.opacity = dim ? String(CFG.night_dim ?? 0.6) : '0';
}
document.addEventListener('touchstart', () => {
  if (isNight()) { nightWakeUntil = Date.now() + 30000; updateNight(); }
}, { passive: true, capture: true });

// Tell the server what screen we're on (shows up in `docker logs echo-dashboard`).
function sayHello() {
  fetch('/api/hello', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio,
                           ua: navigator.userAgent, connected: isConnected() })
  }).catch(() => {});
}

// ── Hard refresh (bottom-right button) ─────────────────────
function hardRefresh() {
  $('refresh-btn').classList.add('spin');
  // cache-busting query so the WebView can't serve a stale copy
  location.replace('/dashboard.html?_=' + Date.now());
}

// ── Init ───────────────────────────────────────────────────
fitStage();
clockTick();
applyLikeUI();
(async () => {
  try { CFG = await (await fetch('/api/config', { cache: 'no-store' })).json(); }
  catch (e) { setStatus(false); }
  await handleOAuthCallback();
  showConnectButton();
  sayHello();

  updateVolSlider(volume);
  updateWeather();
  updateNight();
  setInterval(updateNight, 5000);
  setInterval(updateWeather, 15 * 60 * 1000);
  setInterval(updateIdle, 5000);
  setInterval(checkVersion, 5 * 60 * 1000);
  requestAnimationFrame(frame);
  pollLoop();
})();

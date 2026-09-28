// Echo Dashboard — Spotify now-playing for Echo Show kiosks.
// All Spotify calls go straight from the browser to api.spotify.com; the only
// thing the local server does is hold the client secret for token exchange/refresh.

// ── Config (filled from /api/config) ───────────────────────
let CFG = { client_id: '', redirect_uri: '', lat: null, lon: null, version: '' };
const SP_API    = 'https://api.spotify.com/v1';
// Must stay identical to the old build so tokens already saved on the Echo keep working.
const SP_SCOPES = 'user-read-playback-state user-read-currently-playing user-library-read user-library-modify user-modify-playback-state';
const IDLE_AFTER_MS = 5 * 60 * 1000;

// ── State ──────────────────────────────────────────────────
let isPlaying = false, isShuffle = false, isLiked = false, isLoop = false;
let duration = 0, position = 0, volume = 50;
let progressInterval = null, lastArt = '', lastTrack = '';
let intervalStartPos = 0, intervalStartTime = 0;
let isDragging = false, activeScrubber = 'main';
let onLyricsPage = false, queueOpen = false, userRequestedLyrics = false;
let currentTrackId = null, currentItemType = 'track';
let controlLockUntil = 0;      // ignore polled play/shuffle/loop right after a tap
let idleSince = Date.now(), idleShown = false;

const $ = id => document.getElementById(id);

function fmt(s) {
  s = Math.floor(s || 0);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function setProgress(pos, dur) {
  const pct = dur > 0 ? Math.min((pos / dur) * 100, 100) : 0;
  ['main', 'lyrics'].forEach(id => {
    const f = $('fill-' + id), t = $('thumb-' + id), p = $('pos-' + id), d = $('dur-' + id);
    if (f) f.style.width = pct + '%';
    if (t) t.style.left  = pct + '%';
    if (p) p.textContent = fmt(pos);
    if (d) d.textContent = fmt(dur);
  });
}

function setStatus(ok) { $('status-dot').classList.toggle('show', !ok); }

// ── Page switching ─────────────────────────────────────────
function goToLyrics() {
  userRequestedLyrics = true;
  onLyricsPage = true;
  $('page-main').classList.remove('active');
  $('page-lyrics').classList.add('active');
  currentLyricIdx = -1;
  syncLyrics(position);
}
function goToMain() {
  userRequestedLyrics = false;
  onLyricsPage = false;
  $('page-lyrics').classList.remove('active');
  $('page-main').classList.add('active');
}

function setDeviceLabel(name) {
  const text = name ? 'Now playing on ' + name : '';
  $('device-label').textContent = text;
  $('device-label-lyrics').textContent = text;
}

// ── Progress ticker (wall-clock based so JS jitter doesn't drift) ──
function startProgressInterval(fromPos) {
  stopProgressInterval();
  intervalStartPos  = fromPos;
  intervalStartTime = Date.now() - 250;
  progressInterval = setInterval(() => {
    const elapsed = (Date.now() - intervalStartTime) / 1000;
    position = Math.min(intervalStartPos + elapsed, duration);
    setProgress(position, duration);
    if (onLyricsPage) syncLyrics(position);
  }, 100);
}
function stopProgressInterval() {
  if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
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
function showConnectButton() { $('sp-connect-btn').style.display = isConnected() ? 'none' : 'flex'; }

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
  if (!code && !params.get('error')) return;
  if (code && state === localStorage.getItem('sp_oauth_state')) {
    const r = await fetch('/api/spotify/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    if (r.ok) saveSpotifyTokens(await r.json());
  }
  localStorage.removeItem('sp_oauth_state');
  // Spotify redirects to /local/dashboard.html; land back on the kiosk URL.
  window.history.replaceState({}, '', '/dashboard.html');
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

// ── Queue panel ────────────────────────────────────────────
function toggleQueue() {
  queueOpen = !queueOpen;
  $('queue-panel').classList.toggle('open', queueOpen);
  $('queue-backdrop').classList.toggle('open', queueOpen);
  ['queue-btn-main', 'queue-btn-lyrics'].forEach(id => $(id).classList.toggle('active', queueOpen));
  if (queueOpen) fetchQueue();
}

function queueMessage(text, withConnect) {
  const list = $('queue-list');
  list.innerHTML = '';
  const m = document.createElement('div');
  m.style.cssText = 'padding:20px;color:rgba(255,255,255,0.3);font-size:13px;';
  m.textContent = text;
  list.appendChild(m);
  if (withConnect) {
    const b = document.createElement('button');
    b.className = 'lyrics-btn';
    b.style.margin = '0 20px';
    b.textContent = 'Connect Spotify';
    b.onclick = startSpotifyOAuth;
    list.appendChild(b);
  }
}

async function fetchQueue() {
  if (!isConnected()) return queueMessage('Connect Spotify to see your queue.', true);
  if (!$('queue-list').children.length) queueMessage('Loading…');
  const r = await sp('/me/player/queue');
  if (r.ok && r.data) renderQueue(r.data);
  else queueMessage('Couldn’t load the queue.');
}

function renderQueue(data) {
  const list = $('queue-list');
  list.innerHTML = '';
  const addHeader = text => {
    const h = document.createElement('div');
    h.style.cssText = 'padding:10px 28px 4px;font-size:11px;font-weight:600;color:rgba(255,255,255,0.35);letter-spacing:0.8px;text-transform:uppercase;';
    h.textContent = text;
    list.appendChild(h);
  };
  const addTrack = (item, isCurrent) => {
    const info = itemInfo(item);
    const div = document.createElement('div');
    div.className = 'queue-item';
    const artBox = document.createElement('div');
    artBox.className = 'queue-item-art';
    if (info.art) { const img = document.createElement('img'); img.src = info.art; img.loading = 'lazy'; artBox.appendChild(img); }
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
    list.appendChild(div);
  };
  if (data.currently_playing) { addHeader('Now Playing'); addTrack(data.currently_playing, true); }
  if (data.queue?.length) { addHeader('Next Up'); data.queue.slice(0, 15).forEach(t => addTrack(t, false)); }
  if (!data.currently_playing && !data.queue?.length) queueMessage('Queue is empty.');
}

// Normalises tracks and podcast episodes into one shape.
function itemInfo(item) {
  if (!item) return { name: '', artist: '', album: '', art: '' };
  if (item.type === 'episode') {
    return {
      name: item.name || '',
      artist: item.show?.publisher || item.show?.name || '',
      album: item.show?.name || '',
      art: item.images?.[0]?.url || item.show?.images?.[0]?.url || ''
    };
  }
  return {
    name: item.name || '',
    artist: item.artists?.map(a => a.name).join(', ') || '',
    firstArtist: item.artists?.[0]?.name || '',
    album: item.album?.name || '',
    art: item.album?.images?.[0]?.url || ''
  };
}

// ── Clock ──────────────────────────────────────────────────
const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function updateClock() {
  const now = new Date();
  let h = now.getHours();
  const m = now.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const t = h + ':' + m + ' ' + ampm;
  const date = DAYS[now.getDay()] + ', ' + MONTHS[now.getMonth()] + ' ' + now.getDate();
  $('time').textContent = t;
  $('lyr-time').textContent = t;
  $('date').textContent = date;
  $('idle-time').textContent = h + ':' + m;
  $('idle-date').textContent = date;
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
  if (!c) { $('w-icon').textContent = ''; $('w-temp').textContent = ''; $('w-desc').textContent = ''; return; }
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}` +
                          `&current=temperature_2m,weather_code&temperature_unit=fahrenheit`);
    const d = await r.json();
    const t = Math.round(d.current.temperature_2m), wmo = d.current.weather_code;
    $('w-icon').textContent = WMO_CODE[wmo] || '🌡️';
    $('w-temp').textContent = t + '°F';
    $('w-desc').textContent = WMO_DESC[wmo] || '';
    $('idle-weather').textContent = (WMO_CODE[wmo] || '') + ' ' + t + '°F · ' + (WMO_DESC[wmo] || '');
  } catch (e) {}
}

// ── UI sync helpers ────────────────────────────────────────
function applyPlayUI() {
  const path = isPlaying ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
  ['play-icon', 'play-icon-lyrics'].forEach(id => { $(id).innerHTML = path; });
}
function applyShuffleUI() { ['shuffle-btn-main', 'shuffle-btn-lyrics'].forEach(id => $(id).classList.toggle('shuffle-on', isShuffle)); }
function applyLoopUI()    { ['loop-btn-main', 'loop-btn-lyrics'].forEach(id => $(id).classList.toggle('loop-on', isLoop)); }

const HEART_OUTLINE = `<path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/>`;
const HEART_FILLED  = `<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>`;
function applyLikeUI() {
  const show = currentItemType === 'track';
  [['like-btn-main', 'like-icon'], ['like-btn-lyrics', 'like-icon-lyrics']].forEach(([btn, ico]) => {
    $(btn).classList.toggle('liked', isLiked);
    $(btn).style.visibility = show ? 'visible' : 'hidden';
    $(ico).innerHTML = isLiked ? HEART_FILLED : HEART_OUTLINE;
  });
}

function setArt(url) {
  ['art-wrap', 'art-wrap-lyrics'].forEach(id => {
    const img = document.createElement('img');
    img.src = url;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
    $(id).replaceChildren(img);
  });
  $('bg').style.backgroundImage = `url('${url}')`;
}

function setTrackText(info) {
  $('track-name').textContent = info.name;
  $('lyr-track-name').textContent = info.name;
  $('lyr-meta-row').textContent = [info.artist, info.album].filter(Boolean).join(' • ');
  const meta = $('track-meta');
  meta.innerHTML = '';
  const span = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; meta.appendChild(s); };
  if (info.artist) span('track-artist', info.artist);
  if (info.artist && info.album) span('meta-dot', '•');
  if (info.album) span('track-album', info.album);
}

function showNothingPlaying() {
  $('track-name').innerHTML = '<span class="not-playing">' + (isConnected() ? 'Nothing playing' : 'Spotify not connected') + '</span>';
  $('lyr-track-name').textContent = 'Nothing playing';
  $('lyr-meta-row').textContent = '';
  $('track-meta').innerHTML = '';
  setDeviceLabel('');
  lyricsLines = [];
  lastTrack = '';
  isPlaying = false;
  applyPlayUI();
  stopProgressInterval();
}

// ── Controls ───────────────────────────────────────────────
function lockControls() { controlLockUntil = Date.now() + 1500; }
function pollSoon(...delays) { delays.forEach(d => setTimeout(updateFromSpotify, d)); }

async function togglePlay() {
  wakeFromIdle();
  isPlaying = !isPlaying; applyPlayUI(); lockControls();
  if (!isPlaying) stopProgressInterval(); else if (duration) startProgressInterval(position);
  let r = await sp(`/me/player/${isPlaying ? 'play' : 'pause'}`, 'PUT');
  // No active device (e.g. Spotify went idle) → wake the last device we saw.
  if (!r.ok && r.status === 404 && isPlaying) {
    const dev = localStorage.getItem('sp_last_device');
    if (dev) r = await sp('/me/player', 'PUT', { device_ids: [dev], play: true });
  }
  if (!r.ok) { controlLockUntil = 0; }
  pollSoon(400, 1200);
}
async function nextTrack() {
  stopProgressInterval();
  await sp('/me/player/next', 'POST');
  pollSoon(300, 800, 1500);
}
async function prevTrack() {
  stopProgressInterval();
  await sp('/me/player/previous', 'POST');
  pollSoon(300, 800, 1500);
}
async function toggleShuffle() {
  isShuffle = !isShuffle; applyShuffleUI(); lockControls();
  await sp(`/me/player/shuffle?state=${isShuffle}`, 'PUT');
}
async function toggleLoop() {
  isLoop = !isLoop; applyLoopUI(); lockControls();
  await sp(`/me/player/repeat?state=${isLoop ? 'context' : 'off'}`, 'PUT');
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

// ── Volume popups ──────────────────────────────────────────
let volMainOpen = false, volLyricsOpen = false, volCloseTimer = null;
function armVolAutoClose() {
  clearTimeout(volCloseTimer);
  volCloseTimer = setTimeout(() => {
    if (volDragging) return armVolAutoClose();
    if (volMainOpen) toggleVolMain();
    if (volLyricsOpen) toggleVolLyrics();
  }, 6000);
}
function toggleVolMain() {
  volMainOpen = !volMainOpen;
  $('vol-popup').classList.toggle('open', volMainOpen);
  $('vol-btn-main').classList.toggle('active', volMainOpen);
  if (volMainOpen) armVolAutoClose();
}
function toggleVolLyrics() {
  volLyricsOpen = !volLyricsOpen;
  $('vol-popup-lyrics').classList.toggle('open', volLyricsOpen);
  $('vol-btn-lyrics').classList.toggle('active', volLyricsOpen);
  if (volLyricsOpen) armVolAutoClose();
}
function updateVolSlider(val) {
  const pct = Math.max(0, Math.min(100, val)) + '%';
  ['main', 'lyrics'].forEach(which => {
    $('vol-fill-' + which).style.width = pct;
    $('vol-thumb-' + which).style.left = pct;
    $('vol-thumb-' + which).style.marginLeft = '-7px';
  });
}

let volDragging = false, volWhich = 'main', volTimer = null, volLockUntil = 0;
function getClientX(e) {
  return e.touches?.length ? e.touches[0].clientX : (e.changedTouches?.length ? e.changedTouches[0].clientX : e.clientX);
}
function volScrubStart(e, which) {
  e.preventDefault();
  volDragging = true; volWhich = which;
  volApply(e);
}
function volApply(e) {
  const rect = $('vol-track-' + volWhich).getBoundingClientRect();
  volume = Math.round(Math.max(0, Math.min(1, (getClientX(e) - rect.left) / rect.width)) * 100);
  updateVolSlider(volume);
  volLockUntil = Date.now() + 2500;
  armVolAutoClose();
  clearTimeout(volTimer);
  volTimer = setTimeout(() => sp(`/me/player/volume?volume_percent=${volume}`, 'PUT'), 300);
}
function volScrubEnd() { volDragging = false; }

// ── Seek scrubber ──────────────────────────────────────────
function scrubPct(e) {
  const rect = $('scrubber-' + activeScrubber).getBoundingClientRect();
  return Math.max(0, Math.min(1, (getClientX(e) - rect.left) / rect.width));
}
function scrubStart(e, which) {
  e.preventDefault();
  activeScrubber = which; isDragging = true;
  stopProgressInterval();
  $('fill-' + which).classList.add('instant');
  currentLyricIdx = -1;
  scrubApply(e);
}
function scrubApply(e) {
  const pct = scrubPct(e);
  $('fill-'  + activeScrubber).style.width = (pct * 100) + '%';
  $('thumb-' + activeScrubber).style.left  = (pct * 100) + '%';
  $('pos-'   + activeScrubber).textContent = fmt(pct * duration);
}
async function scrubEnd(e) {
  if (!isDragging) return;
  isDragging = false;
  $('fill-' + activeScrubber).classList.remove('instant');
  position = scrubPct(e) * duration;
  setProgress(position, duration);
  currentLyricIdx = -1;
  if (isPlaying && duration > 0) startProgressInterval(position);
  if (onLyricsPage) syncLyrics(position);
  await sp(`/me/player/seek?position_ms=${Math.floor(position * 1000)}`, 'PUT');
}

document.addEventListener('mousemove', e => { if (isDragging) scrubApply(e); if (volDragging) volApply(e); });
document.addEventListener('mouseup',   e => { if (isDragging) scrubEnd(e);   if (volDragging) volScrubEnd(e); });
document.addEventListener('touchmove', e => {
  if (isDragging)  { e.preventDefault(); scrubApply(e); }
  if (volDragging) { e.preventDefault(); volApply(e); }
}, { passive: false });
document.addEventListener('touchend',  e => { if (isDragging) scrubEnd(e); if (volDragging) volScrubEnd(e); });

// ── Lyrics (lrclib.net) ────────────────────────────────────
let lyricsLines = [], currentLyricIdx = -1;
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
  lyricsLines = []; currentLyricIdx = -1;
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
      inner.appendChild(el);
    });
    if (userRequestedLyrics && !onLyricsPage) goToLyrics();
    syncLyrics(position);
  } else if (res?.plain?.length) {
    res.plain.forEach(text => {
      const el = document.createElement('div');
      el.className = 'lyric-line near'; el.textContent = text;
      inner.appendChild(el);
    });
  } else {
    inner.innerHTML = '<div class="lyrics-status-msg">No lyrics found.</div>';
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

function syncLyrics(pos) {
  if (!lyricsLines.length) return;
  let idx = 0;
  for (let i = 0; i < lyricsLines.length; i++) {
    if (lyricsLines[i].time <= pos) idx = i; else break;
  }
  if (idx === currentLyricIdx) return;
  const prev = currentLyricIdx;
  currentLyricIdx = idx;
  // Only touch lines whose class can have changed (±4 around old and new index).
  const touch = new Set();
  [prev, idx].forEach(c => { if (c < 0) return; for (let i = c - 4; i <= c + 4; i++) touch.add(i); });
  if (prev < 0) lyricsLines.forEach((_, i) => touch.add(i));
  touch.forEach(i => {
    const el = $('lyric-' + i);
    if (!el) return;
    el.classList.remove('active', 'near');
    if (i === idx) el.classList.add('active');
    else if (Math.abs(i - idx) <= 3) el.classList.add('near');
  });
  const inner = $('lyrics-inner'), active = $('lyric-' + idx);
  if (!inner || !active) return;
  const target = (active.offsetTop - inner.offsetTop) - inner.clientHeight / 2 + active.offsetHeight / 2;
  inner.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
}

// ── Idle screen (burn-in friendly clock when nothing is playing) ──
function updateIdle() {
  if (isPlaying || queueOpen || isDragging) { idleSince = Date.now(); }
  const shouldShow = Date.now() - idleSince > IDLE_AFTER_MS;
  if (shouldShow !== idleShown) {
    idleShown = shouldShow;
    $('idle').classList.toggle('show', shouldShow);
  }
  if (idleShown) {
    // drift the clock a little every minute so nothing sits on the same pixels
    const n = Math.floor(Date.now() / 60000);
    $('idle-inner').style.transform = `translate(${(n * 37) % 80 - 40}px, ${(n * 23) % 60 - 30}px)`;
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
    const newDuration = (item.duration_ms || 0) / 1000;
    const newPos = (data.progress_ms || 0) / 1000;

    if (data.device?.id) localStorage.setItem('sp_last_device', data.device.id);
    setDeviceLabel(data.device?.name || '');

    if (Date.now() >= controlLockUntil) {
      isPlaying = !!data.is_playing;
      isShuffle = !!data.shuffle_state;
      isLoop    = data.repeat_state !== 'off';
      applyPlayUI(); applyShuffleUI(); applyLoopUI();
    }
    const newVol = data.device?.volume_percent;
    if (newVol != null && newVol !== volume && Date.now() >= volLockUntil && !volDragging) {
      volume = newVol; updateVolSlider(volume);
    }

    const isNewTrack = item.id !== lastTrack;
    if (isNewTrack) {
      lastTrack = item.id;
      currentTrackId = item.id;
      currentItemType = item.type || 'track';
      isLiked = false; likeLockUntil = 0; applyLikeUI();
      stopProgressInterval();
      currentLyricIdx = -1;
      checkIfLiked(item.id, true);
      setTrackText(info);
      if (info.art && info.art !== lastArt) { lastArt = info.art; setArt(info.art); }
      duration = newDuration;
      if (currentItemType === 'track') {
        fetchLyrics(item.id, info.name, info.firstArtist || info.artist, info.album, Math.round(duration));
      } else {
        lyricsLines = [];
        $('lyrics-inner').innerHTML = '<div class="lyrics-status-msg">No lyrics for podcasts.</div>';
      }
      if (queueOpen) fetchQueue();
      wakeFromIdle();
    }

    duration = newDuration;
    // Re-sync the ticker only when it has drifted noticeably, so the bar doesn't jitter.
    const drift = Math.abs(position - newPos);
    if (!isDragging) {
      if (!isPlaying) { stopProgressInterval(); position = newPos; }
      else if (!progressInterval || drift > 1.5) { position = newPos; startProgressInterval(position); }
    }
    setProgress(position, duration);
    if (onLyricsPage && lyricsLines.length) syncLyrics(position);
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

// ── Init ───────────────────────────────────────────────────
(async () => {
  try { CFG = await (await fetch('/api/config', { cache: 'no-store' })).json(); }
  catch (e) { setStatus(false); }
  await handleOAuthCallback();
  showConnectButton();

  updateClock();
  updateVolSlider(volume);
  updateWeather();
  setInterval(updateClock, 1000);
  setInterval(updateWeather, 15 * 60 * 1000);
  setInterval(updateIdle, 5000);
  setInterval(checkVersion, 5 * 60 * 1000);
  pollLoop();
})();

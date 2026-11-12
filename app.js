/* Swipeify — Spotify Premium discovery with Authorization Code + PKCE.
   Client IDs are public identifiers. Never place a Spotify client secret here. */
'use strict';

const CLIENT_ID = '86711c943a9f4f54a08e02cba2a80642';
const SCOPES = [
  'user-read-private', 'user-read-email', 'user-top-read',
  'user-read-recently-played', 'streaming',
  'user-read-playback-state', 'user-modify-playback-state',
  'user-library-modify', 'playlist-read-private', 'playlist-read-collaborative'
];
const API = 'https://api.spotify.com/v1';
const AUTH_BASE = 'https://accounts.spotify.com';
const STORAGE_KEY = 'swipeify-v1';
const TOKEN_KEY = 'swipeify-spotify-token-v1';
const PKCE_KEY = 'swipeify-pkce-v1';
const $ = (id) => document.getElementById(id);
const DEFAULT_COVER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><defs><linearGradient id="g"><stop stop-color="#304e46"/><stop offset="1" stop-color="#433357"/></linearGradient></defs><rect width="600" height="600" fill="url(#g)"/><text x="300" y="350" font-family="Arial" font-size="200" fill="#baf4af" text-anchor="middle">♫</text></svg>');

function readStored(key, storage, fallback) {
  try { return JSON.parse(storage.getItem(key)) || fallback; } catch (_) { return fallback; }
}
const saved = readStored(STORAGE_KEY, localStorage, {});
const state = {
  tokens: readStored(TOKEN_KEY, sessionStorage, null),
  genre: saved.genre || 'drum and bass',
  adventure: Number.isFinite(saved.adventure) ? saved.adventure : 50,
  decisions: Array.isArray(saved.decisions) ? saved.decisions : [],
  bookmarks: Array.isArray(saved.bookmarks) ? saved.bookmarks : [],
  queue: [], current: null, undo: null, fetching: null, swiping: false,
  topArtists: [], knownTracks: new Set(), playlistTrackIds: new Set(),
  playlistTrackKeys: new Set(), playlistScan: null, user: null, player: null, deviceId: null,
  playback: { position: 0, duration: 0, updatedAt: 0, paused: true },
  started: false, autoPlayNext: false, pendingPlay: false, endHandled: false, loading: false, refreshPromise: null,
  searchRound: 0, genreGeneration: 0, toastTimer: null, genreHint: ''
};
function hasPlaylistScopes() {
  const allowed = new Set((state.tokens?.scope || '').split(/\s+/));
  return allowed.has('playlist-read-private') && allowed.has('playlist-read-collaborative');
}
function setPlaylistStatus(message) {
  const el = $('playlistFilterStatus');
  if (el) { el.textContent = message; el.classList.remove('hidden'); }
  const loading = $('loadingText');
  if (loading && !$('loadingState').classList.contains('hidden')) loading.textContent = message;
}
function normalizeSongKey(name, artist) {
  // A different album edition can have a different Spotify ID for the same recording.
  // Avoid duplicate titles by the same primary artist; keep remixes distinct.
  const clean = (value) => String(value || '').normalize('NFKC')
    .toLowerCase().replace(/\s*[-–—]\s*(?:\d{4}\s*)?remaster(?:ed)?(?:\s*\d{4})?\s*$/i, '')
    .replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return clean(name) + '|' + clean(artist);
}
function savePreferences() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    genre: state.genre, adventure: state.adventure,
    decisions: state.decisions.slice(-700), bookmarks: state.bookmarks.slice(-80)
  }));
}
function redirectUri() {
  if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') return location.origin + '/callback';
  return location.origin + location.pathname;
}
function returnHome() {
  if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
    history.replaceState({}, '', '/');
  } else {
    history.replaceState({}, '', location.pathname);
  }
}
function randomString(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
function base64url(bytes) {
  return btoa(String.fromCharCode.apply(null, Array.from(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function challengeFor(verifier) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}
async function login() {
  try {
    const verifier = randomString(64), nonce = randomString(24), redirect = redirectUri();
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, nonce, redirect }));
    const params = new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID, scope: SCOPES.join(' '),
      redirect_uri: redirect, state: nonce, code_challenge_method: 'S256',
      code_challenge: await challengeFor(verifier), show_dialog: 'false'
    });
    location.assign(AUTH_BASE + '/authorize?' + params.toString());
  } catch (error) { showToast('Unable to start Spotify sign-in: ' + error.message); }
}
async function exchangeToken(data) {
  const res = await fetch(AUTH_BASE + '/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data)
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error_description || payload.error || 'Token exchange failed (' + res.status + ')');
  state.tokens = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || (state.tokens && state.tokens.refresh_token),
    expires_at: Date.now() + (payload.expires_in || 3600) * 1000,
    scope: payload.scope || (data.grant_type === 'authorization_code'
      ? SCOPES.join(' ') : (state.tokens?.scope || ''))
  };
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(state.tokens));
  return state.tokens.access_token;
}
async function handleOAuthCallback() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return;
  const pending = readStored(PKCE_KEY, sessionStorage, null);
  try {
    if (params.has('error')) throw new Error(params.get('error_description') || params.get('error'));
    if (!pending || params.get('state') !== pending.nonce) throw new Error('The login session expired or the Spotify state did not match. Try connecting again.');
    await exchangeToken({
      client_id: CLIENT_ID, grant_type: 'authorization_code',
      code: params.get('code'), redirect_uri: pending.redirect, code_verifier: pending.verifier
    });
  } catch (error) {
    sessionStorage.removeItem(TOKEN_KEY);
    state.tokens = null;
    state.authError = error.message;
  } finally {
    sessionStorage.removeItem(PKCE_KEY);
    returnHome();
  }
}
async function token() {
  if (!state.tokens) throw new Error('Connect your Spotify account first.');
  if (Date.now() < state.tokens.expires_at - 60000) return state.tokens.access_token;
  if (!state.tokens.refresh_token) throw new Error('Your Spotify session expired. Please reconnect.');
  if (!state.refreshPromise) {
    state.refreshPromise = exchangeToken({
      grant_type: 'refresh_token', refresh_token: state.tokens.refresh_token, client_id: CLIENT_ID
    }).finally(() => { state.refreshPromise = null; });
  }
  return state.refreshPromise;
}
async function spotify(path, options, retry) {
  const settings = options || {};
  const headers = Object.assign({ Authorization: 'Bearer ' + await token() }, settings.body ? { 'Content-Type': 'application/json' } : {});
  const res = await fetch(API + path, Object.assign({}, settings, { headers: Object.assign(headers, settings.headers || {}) }));
  if (res.status === 401 && !retry && state.tokens && state.tokens.refresh_token) {
    state.tokens.expires_at = 0;
    await token();
    return spotify(path, options, true);
  }
  if (res.status === 204 || res.status === 202) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof body.error === 'object' ? body.error.message : body.error;
    const extra = res.status === 429 ? ' Rate limited: try again in a little while.' : '';
    throw new Error('Spotify ' + res.status + ': ' + (message || res.statusText) + extra);
  }
  return body;
}
function showToast(message) {
  const el = $('toast');
  el.textContent = message; el.classList.remove('hidden');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.add('hidden'), 4200);
}
function showError(title, detail) {
  state.loading = false;
  $('loadingState').classList.add('hidden');
  $('discovery').classList.add('hidden');
  $('errorState').classList.remove('hidden');
  $('errorTitle').textContent = title;
  $('errorMessage').textContent = detail;
}
function showLoading(text) {
  $('errorState').classList.add('hidden');
  $('discovery').classList.add('hidden');
  $('loadingState').classList.remove('hidden');
  $('loadingText').textContent = text || 'Finding your next favourite…';
}
function showDiscovery() {
  $('loadingState').classList.add('hidden');
  $('errorState').classList.add('hidden');
  $('discovery').classList.remove('hidden');
}
function updateStats() {
  $('likeCount').textContent = state.decisions.filter((d) => d.action === 'like' || d.action === 'super').length;
  $('skipCount').textContent = state.decisions.filter((d) => d.action === 'skip').length;
  $('savedCount').textContent = state.bookmarks.length;
  const list = $('savedList'); list.replaceChildren();
  if (!state.bookmarks.length) {
    const p = document.createElement('p'); p.className = 'empty-saved'; p.textContent = 'Nothing saved yet.'; list.append(p);
  } else {
    state.bookmarks.slice(-5).reverse().forEach((entry) => {
      const row = document.createElement('div'); row.className = 'saved-item';
      const info = document.createElement('div'); info.textContent = entry.name;
      const subtitle = document.createElement('span'); subtitle.textContent = entry.artist; info.append(subtitle);
      const link = document.createElement('a'); link.href = entry.url || 'https://open.spotify.com'; link.target = '_blank';
      link.rel = 'noopener noreferrer'; link.textContent = '↗'; link.setAttribute('aria-label', 'Open ' + entry.name + ' on Spotify');
      row.append(info, link); list.append(row);
    });
  }
}
function setGenreUI() {
  document.querySelectorAll('.genre').forEach((button) => {
    const active = button.dataset.genre === state.genre;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('adventure').value = String(state.adventure);
  $('adventureLabel').textContent = state.adventure < 34 ? 'Familiar' : state.adventure > 67 ? 'Adventurous' : 'Balanced';
}
function normalizeTrack(track, source) {
  if (!track || !track.id || !track.uri || !track.album || !Array.isArray(track.artists)) return null;
  if (track.is_playable === false || track.is_local || track.type !== 'track') return null;
  return {
    id: track.id, uri: track.uri, name: track.name || 'Unknown song',
    artist: track.artists.map((a) => a.name).filter(Boolean).join(', ') || 'Unknown artist',
    artistIds: track.artists.map((a) => a.id).filter(Boolean),
    artistNames: track.artists.map((a) => a.name).filter(Boolean),
    primaryArtist: track.artists[0]?.name || '',
    linkedId: track.linked_from?.id || null,
    album: track.album.name || 'Single',
    cover: (track.album.images || [])[0]?.url || DEFAULT_COVER,
    duration: track.duration_ms || 0,
    url: (track.external_urls && track.external_urls.spotify) || 'https://open.spotify.com/track/' + track.id,
    source: source || state.genre, score: 0
  };
}
function scoreTrack(track) {
  const topIds = new Set(state.topArtists.slice(0, 20).map((a) => a.id));
  const likedArtistNames = new Set(state.decisions.filter((d) => ['like','super'].includes(d.action)).map((d) => d.artist));
  const isFamiliar = track.artistIds.some((id) => topIds.has(id));
  const likedBefore = likedArtistNames.has(track.artist);
  const familiarWeight = (50 - state.adventure) / 50;
  return Math.random() * 24 + (isFamiliar ? 23 * familiarWeight : 15 * (1 - familiarWeight)) +
    (likedBefore ? 21 * familiarWeight : 0) + (track.source === state.genre ? 20 : 0);
}
function seenIds() {
  return new Set(state.decisions.map((d) => d.id)
    .concat(state.queue.map((t) => t.id), state.current ? [state.current.id] : [],
      Array.from(state.knownTracks), Array.from(state.playlistTrackIds)));
}
function isAlreadyOwned(track) {
  return state.playlistTrackIds.has(track.id) ||
    (track.linkedId && state.playlistTrackIds.has(track.linkedId)) ||
    state.playlistTrackKeys.has(normalizeSongKey(track.name, track.primaryArtist));
}
function scanPlaylistItem(entry) {
  const track = entry?.item || entry?.track;
  if (!track || track.type !== 'track') return;
  if (track.id) state.playlistTrackIds.add(track.id);
  if (track.linked_from?.id) state.playlistTrackIds.add(track.linked_from.id);
  if (track.name && track.artists?.length) {
    state.playlistTrackKeys.add(normalizeSongKey(track.name, track.artists[0]?.name));
  }
}
async function readOnePlaylist(playlist) {
  const perPage = 50; let offset = 0;
  for (;;) {
    const page = await spotify('/playlists/' + encodeURIComponent(playlist.id) +
      '/items?limit=' + perPage + '&offset=' + offset);
    const items = Array.isArray(page?.items) ? page.items : [];
    for (const entry of items) scanPlaylistItem(entry);
    offset += items.length;
    if (!items.length || !page.next || (Number.isFinite(page.total) && offset >= page.total)) break;
  }
}
async function loadPlaylistExclusions() {
  // Spotify's 2026 Development Mode API can only read playlist items for
  // playlists the user owns or collaborates on, not followed-only playlists.
  state.playlistTrackIds = new Set();
  state.playlistTrackKeys = new Set();
  setPlaylistStatus('Checking your playlists before suggesting songs…');
  const playlists = [];
  for (let offset = 0;;) {
    const page = await spotify('/me/playlists?limit=50&offset=' + offset);
    const entries = Array.isArray(page?.items) ? page.items : [];
    playlists.push(...entries);
    offset += entries.length;
    if (!entries.length || !page.next || (Number.isFinite(page.total) && offset >= page.total)) break;
  }
  const unique = [...new Map(playlists.filter((p) => p?.id).map((p) => [p.id, p])).values()];
  const readable = unique.filter((p) => p.owner?.id === state.user?.id || p.collaborative === true);
  const followedOnly = unique.length - readable.length;
  let scanned = 0;
  const failures = [];
  let index = 0;
  async function worker() {
    while (index < readable.length) {
      const playlist = readable[index++];
      try { await readOnePlaylist(playlist); }
      catch (error) { failures.push(playlist.name + ': ' + error.message); }
      scanned++;
      setPlaylistStatus('Checking playlists ' + scanned + '/' + readable.length + '…');
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, readable.length) }, worker));
  if (failures.length) {
    throw new Error('Could not fully scan your playlists (' + failures[0] +
      '). Retry before discovering songs to avoid repeats.');
  }
  state.playlistScan = {
    scanned, followedOnly,
    songs: state.playlistTrackIds.size, completeForReadable: true
  };
  let description = '✓ Excluding ' + state.playlistTrackIds.size +
    ' existing songs from ' + scanned + ' playlists';
  if (followedOnly) description += ' · ' + followedOnly +
    ' followed-only playlist(s) cannot be checked by Spotify';
  if (!scanned) description = followedOnly
    ? 'Spotify cannot read tracks from followed-only playlists; only owned/collaborative playlists can be filtered.'
    : 'No playlists found. New discoveries will still exclude recent and top tracks.';
  setPlaylistStatus(description);
}
// Artist rosters act as a genre guardrail. Spotify's search results can include
// unrelated artists, even for artist:"..." queries, and track objects no longer
// reliably expose genre fields in Development Mode. Discovery intensity must
// change *familiarity within a genre*, never switch to a different genre.
const GENRE_ARTISTS = Object.freeze({
  'drum and bass': [
    'Bou','Hedex','Kanine','K Motionz','Mozey','Sota','Sub Focus','Dimension',
    'Culture Shock','1991','Metrik','Grafix','Delta Heavy','Andy C','A.M.C',
    'DJ Hazard','Serum','Turno','Simula','Basstripper','Disrupta','Amplify',
    'T95','Voltage','Friction','Camo & Krooked','Hybrid Minds','Pola & Bryson',
    'High Contrast','Wilkinson','Netsky','Chase & Status','Pendulum',
    'Macky Gee','Nia Archives','Alcemist','Vibe Chemistry','Break','Enei',
    'S.P.Y','Emperor','Koven','Shy FX','Technimatic','Unglued','Rockwell',
    'Benny L','Phibes','Dominator','Teddy Killerz','Annix','Nu:Tone','BCee',
    'Dillinja','Kings Of The Rollers','DJ Marky'
  ],
  'grime': [
    'Skepta','JME','D Double E','P Money','Ghetts','Kano','Wiley',
    'Dizzee Rascal','Novelist','Jammer','Frisco','Chip','Stormzy','AJ Tracey',
    'Manga Saint Hilare','Flowdan','Jaykae','Capo Lee','Riko Dan',
    'President T','Footsie','Mez','Scrufizzer','Merky ACE','Logan','Big Zuu'
  ],
  'uk drill': [
    'Headie One','Digga D','Unknown T','K-Trap','67','410','OFB',
    'Abra Cadabra','Loski','Kwengface','PS Hitsquad','M24','Tion Wayne',
    'Russ Millions','Nito NB','Suspect','Clavish','Central Cee','2Smokeyy',
    'AM','Skengdo','LD','CB','DigDat'
  ],
  'hip hop': [
    'Kendrick Lamar','J. Cole','Travis Scott','Tyler, The Creator',
    'JID','Nas','Denzel Curry','A$AP Rocky','MF DOOM','Joey Bada$$',
    'Baby Keem','Drake','21 Savage','Future','Metro Boomin','Don Toliver',
    'Vince Staples','Freddie Gibbs','Little Simz','Mac Miller','Saba',
    'Earl Sweatshirt','Schoolboy Q','Kid Cudi'
  ],
  'house': [
    'Disclosure','MK','Dom Dolla','Chris Lake','John Summit','FISHER',
    'Sonny Fodera','Gorgon City','James Hype','CamelPhat','Peggy Gou',
    'Fred again..','D.O.D','Claptone','Biscits','Duke Dumont','Low Steppa',
    'ACRAZE','Honey Dijon','Dennis Ferrer','Chris Stussy','Eats Everything'
  ],
  'pop': [
    'Dua Lipa','Charli xcx','Billie Eilish','Olivia Rodrigo','Sabrina Carpenter',
    'The Weeknd','Taylor Swift','Ariana Grande','Harry Styles','Lorde',
    'Rina Sawayama','Chappell Roan','Miley Cyrus','Caroline Polachek',
    'Troye Sivan','Lady Gaga','Tate McRae','PinkPantheress','RAYE'
  ],
  'indie': [
    'Arctic Monkeys','The Strokes','Tame Impala','The 1975','Fontaines D.C.',
    'Wet Leg','Inhaler','Wolf Alice','The Last Dinner Party','Gorillaz',
    'Foals','Two Door Cinema Club','The Wombats','Bloc Party','The Kooks',
    'The Smiths','Pulp','The Libertines','Cage The Elephant','Vampire Weekend'
  ],
  'garage': [
    'Sammy Virji','Interplanetary Criminal','Conducta','Oppidan','MPH',
    'Main Phase','DJ EZ','DJ Q','MJ Cole','Artful Dodger','Sharda',
    'Soul Mass Transit System','Silva Bumpa','Bakey','Y U QT','Champion',
    'salute','Eliza Rose','Todd Edwards','M-Dubs','Tuff Jam','Zed Bias'
  ]
});
function artistKey(name) {
  return String(name || '').normalize('NFKC').toLowerCase()
    .replace(/&/g, 'and').replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}
function artistsForGenre(genre) {
  return GENRE_ARTISTS[genre] || [];
}
function matchesArtist(track, artist) {
  const key = artistKey(artist);
  return Array.isArray(track.artistNames) && track.artistNames.some((name) => artistKey(name) === key);
}
function matchesSelectedGenre(track, genre) {
  return artistsForGenre(genre).some((artist) => matchesArtist(track, artist));
}
function curatedArtistsForRound(genre, round) {
  const artists = artistsForGenre(genre);
  if (!artists.length) return [];
  const likedNames = state.topArtists.map((a) => artistKey(a.name))
    .concat(state.decisions.filter((d) => ['like', 'super'].includes(d.action))
      .map((d) => artistKey(d.artist)));
  const favs = artists.filter((name) => likedNames.includes(artistKey(name)));
  const seeds = [
    artists[(round * 7 + 3) % artists.length],
    artists[(round * 13 + Math.floor(round / artists.length) + 11) % artists.length]
  ];
  if (state.adventure < 55 && favs.length) seeds[0] = favs[round % favs.length];
  return [...new Set(seeds)];
}
async function searchGenreTracks(genre, offset) {
  const params = new URLSearchParams({
    q: 'genre:"' + genre.replace(/"/g, '') + '"',
    type: 'track', limit: '10', offset: String(offset)
  });
  const result = await spotify('/search?' + params.toString());
  return ((result?.tracks?.items) || [])
    .map((track) => normalizeTrack(track, genre))
    .filter((track) => track && matchesSelectedGenre(track, genre));
}
async function searchArtistTracks(artist, genre, offset) {
  const params = new URLSearchParams({
    q: 'artist:"' + artist.replace(/"/g, '') + '"',
    type: 'track', limit: '10', offset: String(offset)
  });
  const result = await spotify('/search?' + params.toString());
  return ((result?.tracks?.items) || [])
    .map((track) => normalizeTrack(track, genre))
    // Spotify Search may return partial matches: verify the credited artist.
    .filter((track) => track && matchesArtist(track, artist));
}
async function fetchCandidates() {
  if (state.fetching) return state.fetching;
  const genre = state.genre, generation = state.genreGeneration;
  const round = state.searchRound++;
  const offsets = [0, 10, 20, 30, 40, 50, 60, 70, 80];
  const offset = offsets[round % offsets.length];
  const inFlight = (async () => {
    const seeds = curatedArtistsForRound(genre, round);
    const requests = [
      searchGenreTracks(genre, offset),
      ...seeds.map((artist, i) => searchArtistTracks(artist, genre, offsets[(round + i * 3) % offsets.length]))
    ];
    const results = await Promise.allSettled(requests);
    if (results.every((result) => result.status === 'rejected')) throw results[0].reason;
    // Discard stale search responses when the listener changes genre.
    if (generation !== state.genreGeneration || genre !== state.genre) return 0;
    const tracks = results.flatMap((r) => r.status === 'fulfilled' ? r.value : []);
    const excluded = seenIds();
    const candidateKeys = new Set(state.queue.map((t) => normalizeSongKey(t.name, t.primaryArtist)));
    const candidates = tracks.filter((track) => {
      const key = normalizeSongKey(track.name, track.primaryArtist);
      if (!matchesSelectedGenre(track, genre) || excluded.has(track.id) ||
          isAlreadyOwned(track) || candidateKeys.has(key)) return false;
      excluded.add(track.id);
      candidateKeys.add(key);
      return true;
    });
    candidates.forEach((track) => { track.score = scoreTrack(track); track.genre = genre; });
    candidates.sort((a, b) => b.score - a.score);
    state.queue.push(...candidates);
    return candidates.length;
  })().finally(() => { if (state.fetching === inFlight) state.fetching = null; });
  state.fetching = inFlight;
  return inFlight;
}
async function loadTaste() {
  const paths = ['/me/top/artists?time_range=medium_term&limit=30', '/me/top/tracks?time_range=medium_term&limit=50',
    '/me/player/recently-played?limit=30'];
  const results = await Promise.allSettled(paths.map((path) => spotify(path)));
  const items = (i) => results[i].status === 'fulfilled' && Array.isArray(results[i].value?.items) ? results[i].value.items : [];
  state.topArtists = items(0);
  const known = items(1).concat(items(2).map((entry) => entry.track)).filter(Boolean);
  state.knownTracks = new Set(known.map((t) => t.id).filter(Boolean));
  if (!state.topArtists.length) {
    const artistMap = new Map();
    for (const track of known) for (const artist of track.artists || []) {
      if (artist.id && !artistMap.has(artist.id)) artistMap.set(artist.id, artist);
    }
    state.topArtists = Array.from(artistMap.values()).slice(0, 25);
  }
  // Spotify may restrict optional genre fields; explicit genre choice stays available.
  const genreNames = state.topArtists.flatMap((a) => Array.isArray(a.genres) ? a.genres : []);
  if (!saved.genre && genreNames.length) {
    const options = Array.from(document.querySelectorAll('.genre')).map((b) => b.dataset.genre);
    const hit = options.find((g) => genreNames.some((v) => v.toLowerCase().includes(g)));
    if (hit) { state.genre = hit; setGenreUI(); }
  }
}
function updateGestureHint() {
  const el = $('gestureHint');
  if (el) el.textContent = state.autoPlayNext
    ? '← pass  •  ↑ save for later  •  love →'
    : 'Tap ▶ or swipe a song to start listening automatically';
}
function renderTrack(track) {
  if (!track) return;
  state.current = track;
  $('coverImage').src = track.cover; $('coverImage').alt = 'Album artwork for ' + track.album;
  $('songTitle').textContent = track.name; $('songArtist').textContent = track.artist;
  $('albumChip').textContent = track.album.length > 26 ? track.album.slice(0, 25) + '…' : track.album;
  $('reasonText').textContent = 'Discovered through ' + track.source + ' · selected for your taste';
  $('matchTag').textContent = '✦ For you';
  $('playerCover').src = track.cover; $('playerTitle').textContent = track.name; $('playerArtist').textContent = track.artist;
  $('sessionTag').textContent = state.genre.toUpperCase();
  $('feedNotice').textContent = ''; $('cardPlayBadge').textContent = '♫';
  updateGestureHint();
  const card = $('trackCard'); card.style.transform = ''; card.style.opacity = ''; card.classList.remove('dragging');
  $('likeStamp').style.opacity = '0'; $('nopeStamp').style.opacity = '0';
  state.playback = { position: 0, duration: track.duration, updatedAt: performance.now(), paused: true };
  state.endHandled = false;
  updateProgress();
}
async function advance(autoplay) {
  const requestedGenre = state.genre;
  if (state.queue.length < 3 && !state.fetching) fetchCandidates().catch((e) => { $('feedNotice').textContent = e.message; });
  if (!state.queue.length) {
    showLoading('Looking for more ' + state.genre + ' tracks…');
    try {
      await fetchCandidates();
      // Search other offsets rather than immediately recycling the same candidates.
      for (let tries = 0; tries < 3 && !state.queue.length; tries++) await fetchCandidates();
      if (state.genre !== requestedGenre) return;
      if (!state.queue.length) throw new Error('No more verified ' + requestedGenre + ' tracks found. Try another genre or reset your swipe history.');
    } catch (error) {
      if (state.genre === requestedGenre) showError('No songs available', error.message);
      return;
    }
  }
  if (state.genre !== requestedGenre) return;
  showDiscovery();
  renderTrack(state.queue.shift());
  if (autoplay) {
    if (state.deviceId) {
      await playCurrent().catch((e) => playerMessage(e.message));
    } else {
      // A swipe can be the first user gesture while the Spotify player is still connecting.
      state.pendingPlay = true;
      playerMessage('Connecting Spotify… your music will start when the player is ready.');
    }
  }
}
function playerMessage(message) { $('playerMessage').textContent = message || ''; }
async function saveToSpotify(track) {
  try {
    await spotify('/me/library?uris=' + encodeURIComponent(track.uri), { method: 'PUT' });
    showToast('♥ Saved ' + track.name + ' to your Spotify Liked Songs');
  } catch (error) {
    showToast('Saved in Swipeify, but Spotify could not save it: ' + error.message);
  }
}
function recordDecision(track, action) {
  if (action === 'auto') return;
  state.decisions.push({ id: track.id, artist: track.artist, action, at: Date.now() });
  if (action === 'bookmark' && !state.bookmarks.some((t) => t.id === track.id)) {
    state.bookmarks.push({ id: track.id, name: track.name, artist: track.artist, url: track.url });
  }
  savePreferences(); updateStats();
}
async function swipe(action) {
  if (!state.current || state.swiping) return;
  state.swiping = true;
  // A deliberate swipe counts as "start listening". Activate Spotify synchronously
  // in the gesture handler before the card animation and network requests.
  if (action !== 'auto') {
    state.autoPlayNext = true;
    if (!state.deviceId) state.pendingPlay = true;
    updateGestureHint();
  }
  if (state.player && typeof state.player.activateElement === 'function') {
    void state.player.activateElement().catch(() => {});
  }
  const track = state.current;
  state.undo = { track, action };
  const card = $('trackCard');
  const dx = action === 'like' || action === 'super' ? 510 : action === 'bookmark' ? 0 : -510;
  const dy = action === 'bookmark' ? -560 : 35;
  card.style.transform = 'translate(' + dx + 'px,' + dy + 'px) rotate(' + (dx > 0 ? 16 : dx < 0 ? -16 : 0) + 'deg)';
  card.style.opacity = '0';
  if (action === 'like' || action === 'super') void saveToSpotify(track);
  recordDecision(track, action);
  await new Promise((resolve) => setTimeout(resolve, 210));
  state.swiping = false;
  await advance(state.autoPlayNext);
}
async function undoSwipe() {
  if (!state.undo || state.swiping) { showToast('Nothing to undo yet'); return; }
  const previous = state.undo; state.undo = null;
  if (state.current) state.queue.unshift(state.current);
  state.decisions = state.decisions.filter((d, i, arr) => i !== arr.findLastIndex((v) => v.id === previous.track.id && v.action === previous.action));
  if (previous.action === 'bookmark') state.bookmarks = state.bookmarks.filter((item) => item.id !== previous.track.id);
  savePreferences(); updateStats();
  renderTrack(previous.track); showDiscovery();
  if (state.autoPlayNext && state.deviceId) await playCurrent().catch((e) => playerMessage(e.message));
  if (previous.action === 'like' || previous.action === 'super') showToast('Song restored. Your Spotify Liked Songs save is unchanged.');
}
async function changeGenre(value) {
  if (state.genre === value) return;
  state.genre = value;
  state.genreGeneration++;
  state.fetching = null;
  state.queue = []; state.searchRound = 0;
  savePreferences(); setGenreUI();
  if (state.tokens) await advance(state.autoPlayNext);
}
async function connectPlayer() {
  if (state.player) return;
  await new Promise((resolve, reject) => {
    if (window.Spotify && window.Spotify.Player) return resolve();
    const script = document.createElement('script');
    window.onSpotifyWebPlaybackSDKReady = resolve;
    script.src = 'https://sdk.scdn.co/spotify-player.js'; script.async = true;
    script.onerror = () => reject(new Error('Spotify player could not load. Disable script blockers and retry.'));
    document.head.appendChild(script);
  });
  const player = new window.Spotify.Player({
    name: 'Swipeify Web Player', volume: 0.7,
    getOAuthToken: async (cb) => { try { cb(await token()); } catch (e) { playerMessage(e.message); } }
  });
  state.player = player;
  player.addListener('ready', ({ device_id }) => {
    state.deviceId = device_id; $('playerBar').classList.remove('hidden');
    playerMessage('Ready. Tap ▶ or swipe a card to start listening.');
    if (state.pendingPlay && state.current) {
      void playCurrent().catch((error) => playerMessage(error.message + ' Tap ▶ if your browser blocked autoplay.'));
    }
  });
  player.addListener('not_ready', () => { state.deviceId = null; playerMessage('Player disconnected. Reconnect or reload the page.'); });
  player.addListener('player_state_changed', (playback) => {
    if (!playback || !state.current) return;
    const active = playback.track_window && playback.track_window.current_track;
    if (active && active.id !== state.current.id) return;
    const previous = state.playback;
    const ended = playback.paused && playback.position === 0 && previous.duration > 10000 &&
      previous.position >= previous.duration - 1500 && !state.endHandled && state.started;
    state.playback = {
      position: playback.position || 0, duration: playback.duration || state.current.duration,
      updatedAt: performance.now(), paused: playback.paused
    };
    if (ended) { state.endHandled = true; void swipe('auto'); }
    $('playPause').textContent = playback.paused ? '▶' : '❚❚';
    $('playPause').setAttribute('aria-label', playback.paused ? 'Play song' : 'Pause song');
    updateProgress();
  });
  player.addListener('initialization_error', ({ message }) => playerMessage('Browser cannot initialize Spotify playback: ' + message));
  player.addListener('authentication_error', ({ message }) => playerMessage('Spotify authentication failed: ' + message));
  player.addListener('account_error', ({ message }) => playerMessage('Spotify Premium is required: ' + message));
  player.addListener('playback_error', ({ message }) => playerMessage('Playback failed: ' + message));
  player.addListener('autoplay_failed', () => {
    state.autoPlayNext = false;
    state.pendingPlay = false;
    updateGestureHint();
    playerMessage('Your browser blocked autoplay. Tap ▶ to enable listening.');
  });
  const connected = await player.connect();
  if (!connected) throw new Error('Spotify Web Playback SDK could not connect. Try Chrome or Edge.');
}
async function playCurrent() {
  if (!state.current) return;
  if (!state.deviceId) { playerMessage('Connecting the Spotify player…'); return; }
  try {
    // The app owns a Spotify Connect device, which is selected before playback.
    await spotify('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [state.deviceId], play: false }) });
    await spotify('/me/player/play?device_id=' + encodeURIComponent(state.deviceId), {
      method: 'PUT', body: JSON.stringify({ uris: [state.current.uri], position_ms: 0 })
    });
    state.started = true;
    state.autoPlayNext = true;
    state.pendingPlay = false;
    state.endHandled = false;
    updateGestureHint();
    state.playback = { position: 0, duration: state.current.duration, updatedAt: performance.now(), paused: false };
    $('playPause').textContent = '❚❚'; playerMessage('');
  } catch (error) {
    playerMessage(error.message + ' If you are on mobile, tap ▶ again.');
    throw error;
  }
}
function updateProgress() {
  const b = state.playback;
  const duration = b.duration || (state.current && state.current.duration) || 0;
  let elapsed = b.position || 0;
  if (!b.paused) elapsed += performance.now() - b.updatedAt;
  elapsed = Math.max(0, Math.min(duration || 0, elapsed));
  $('elapsed').textContent = timecode(elapsed); $('duration').textContent = timecode(duration);
  $('seekBar').value = duration ? String(Math.round(elapsed / duration * 1000)) : '0';
  if (!b.paused && state.autoPlayNext && state.current && duration > 10000 && elapsed >= duration - 250 && !state.endHandled && !state.swiping) {
    state.endHandled = true; void swipe('auto');
  }
}
function timecode(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}
async function togglePlayback() {
  if (!state.current) return;
  if (!state.deviceId) { playerMessage('Waiting for Spotify Web Playback to connect…'); return; }
  // Must be invoked synchronously inside the user gesture on mobile browsers.
  // Keep playback activation inside the user's click/tap event.
  void state.player.activateElement().catch(() => {});
  try {
    if (!state.started) {
      state.autoPlayNext = true;
      return await playCurrent();
    }
    const playback = await state.player.getCurrentState();
    if (!playback || !playback.track_window || playback.track_window.current_track?.id !== state.current.id) return await playCurrent();
    const resuming = playback.paused;
    state.autoPlayNext = resuming;
    updateGestureHint();
    await state.player.togglePlay();
    playerMessage(resuming ? '' : 'Paused. Tap ▶ or swipe to resume music.');
  } catch (error) { playerMessage(error.message); }
}
function attachGestures() {
  const card = $('trackCard'); let drag = null;
  card.addEventListener('pointerdown', (event) => {
    if (!state.current || state.swiping || event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    card.setPointerCapture(event.pointerId); card.classList.add('dragging');
  });
  card.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    card.style.transform = 'translate(' + dx + 'px,' + dy + 'px) rotate(' + (dx * .04) + 'deg)';
    $('likeStamp').style.opacity = String(Math.max(0, Math.min(1, dx / 90)));
    $('nopeStamp').style.opacity = String(Math.max(0, Math.min(1, -dx / 90)));
  });
  function finish(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag = null; card.classList.remove('dragging');
    if (dx > 95) { void swipe('like'); return; }
    if (dx < -95) { void swipe('skip'); return; }
    if (dy < -115) { void swipe('bookmark'); return; }
    card.style.transform = ''; $('likeStamp').style.opacity = '0'; $('nopeStamp').style.opacity = '0';
  }
  card.addEventListener('pointerup', finish);
  card.addEventListener('pointercancel', () => {
    drag = null; card.classList.remove('dragging'); card.style.transform = '';
    $('likeStamp').style.opacity = '0'; $('nopeStamp').style.opacity = '0';
  });
}
function attachEvents() {
  $('loginButton').addEventListener('click', login);
  $('logoutButton').addEventListener('click', logout);
  $('avatarButton').addEventListener('click', () => state.user ? showToast('Connected as ' + (state.user.display_name || state.user.id)) : login());
  $('skipButton').addEventListener('click', () => swipe('skip'));
  $('likeButton').addEventListener('click', () => swipe('like'));
  $('bookmarkButton').addEventListener('click', () => swipe('bookmark'));
  $('superButton').addEventListener('click', () => swipe('super'));
  $('undoButton').addEventListener('click', undoSwipe);
  $('nextButton').addEventListener('click', () => swipe('auto'));
  $('playPause').addEventListener('click', togglePlayback);
  $('retryButton').addEventListener('click', () => advance(state.autoPlayNext));
  $('seekBar').addEventListener('change', async (event) => {
    if (!state.player || !state.started) return;
    const position = Math.round(Number(event.target.value) / 1000 * state.playback.duration);
    try { await state.player.seek(position); } catch (e) { playerMessage(e.message); }
  });
  document.querySelectorAll('.genre').forEach((button) => button.addEventListener('click', () => changeGenre(button.dataset.genre)));
  $('adventure').addEventListener('input', (event) => {
    state.adventure = Number(event.target.value); savePreferences(); setGenreUI();
  });
  $('resetHistory').addEventListener('click', () => {
    if (!confirm('Clear Swipeify swipe history and local bookmarks? Spotify Liked Songs will NOT be removed.')) return;
    state.decisions = []; state.bookmarks = []; state.queue = []; state.searchRound = 0;
    savePreferences(); updateStats(); showToast('Swipeify discovery history cleared.');
    if (state.tokens) void advance(state.autoPlayNext);
  });
  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.altKey || event.ctrlKey || event.metaKey || !state.tokens) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); void swipe('skip'); }
    if (event.key === 'ArrowRight') { event.preventDefault(); void swipe('like'); }
    if (event.key === 'ArrowUp') { event.preventDefault(); void swipe('bookmark'); }
  });
}
function logout() {
  state.player?.disconnect();
  sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(PKCE_KEY);
  location.assign(location.origin + (location.hostname.endsWith('github.io') ? '/Swipeify/' : '/'));
}
async function startApp() {
  attachEvents(); attachGestures(); setGenreUI(); updateStats();
  await handleOAuthCallback();
  if (state.authError) showToast(state.authError);
  if (!state.tokens) return;
  if (!hasPlaylistScopes()) {
    $('loginButton').textContent = 'Reconnect Spotify to exclude playlist songs';
    $('loginGate').querySelector('p').textContent =
      'Swipeify needs playlist-reading permission to avoid recommending songs you already have. Reconnect once to allow this.';
    showToast('Reconnect Spotify once to approve the new playlist permissions.');
    return;
  }
  $('loginGate').classList.add('hidden');
  $('connectionIndicator').classList.add('connected');
  $('connectionText').textContent = 'Spotify connected';
  $('logoutButton').classList.remove('hidden');
  showLoading('Reading your listening taste…');
  try {
    const user = await spotify('/me'); state.user = user;
    $('avatarButton').textContent = ((user.display_name || user.id || 'S')[0] || 'S').toUpperCase();
    $('avatarButton').title = user.display_name || user.id || 'Spotify profile';
    await loadTaste();
    setGenreUI(); savePreferences();
    await loadPlaylistExclusions();
    await advance(false);
    // Spotify SDK is loaded after the discovery card so errors do not block finding tracks.
    connectPlayer().catch((error) => { $('playerBar').classList.remove('hidden'); playerMessage(error.message); });
  } catch (error) {
    showError('Could not load Spotify', error.message + '. Check your developer dashboard redirect URI and account access.');
  }
}
setInterval(() => {
  if (!document.hidden && !state.swiping && state.current) updateProgress();
}, 500);
startApp().catch((error) => showError('Swipeify could not start', error.message));

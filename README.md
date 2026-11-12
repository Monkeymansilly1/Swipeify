# Swipeify 🎧

**Discover your next favourite song. Swipe right to like, left to skip, or up to save it for later.**

A Spotify Premium discovery website using plain HTML, CSS, and JavaScript. No database, server, or Spotify client secret is needed.

## Features

- Full-track streaming in the page with the official Spotify Web Playback SDK.
- Spotify sign-in with Authorization Code + PKCE.
- Swipe cards using touch, mouse or keyboard, plus clear ✕ / ♥ / ♧ / ★ buttons.
- Swipe right or tap ♥ to save to Spotify Liked Songs.
- Genres and discovery intensity help steer the next track; search candidates also use top artists and available listening history.
- Play/pause, seek and next-song controls.
- Local saved-for-later list, previous-track button and swipe counts.
- Genuine Spotify track metadata and artwork, no fabricated example songs.

This is an experimental **custom recommendation engine** using Spotify Search, not Spotify's discontinued Recommendations API. Artist genre fields may be restricted, so the user-selected genre is always available. The app does not train AI on Spotify content.

## Put the app online with GitHub Pages

1. Visit https://developer.spotify.com/dashboard and open the Spotify app corresponding to the Client ID in **app.js**.
2. In **Redirect URIs**, add **exactly**:

       https://monkeymansilly1.github.io/Swipeify/

   **Keep the final slash. Do not add /callback to the GitHub Pages URL.** You can retain existing redirect URLs.
3. If Spotify Developer Mode requests an allowlist, add the Spotify account that will sign into Swipeify under the app's users / user management.
4. Merge the Swipeify pull request into your repository's main branch.
5. On GitHub, go to **Repository → Settings → Pages** and choose **Build and deployment → Source → GitHub Actions**.
6. After the deployment workflow finishes, open https://monkeymansilly1.github.io/Swipeify/ and click **Connect with Spotify**.
7. When the embedded player says **Ready**, click **▶** or **swipe a song** to start music. Afterwards, Swipeify automatically starts the next recommendation on each swipe and when a song finishes. Browsers typically require that first user gesture before unmuted audio can play.

After a merge or another push to main, the included workflow redeploys automatically. You can also trigger it under **Actions → Deploy Swipeify to GitHub Pages → Run workflow**.

## Run locally

1. Add this second Redirect URI in Spotify's app settings:

       http://127.0.0.1:5173/callback

2. Open a terminal in the Swipeify repository and run:

       npx vite --host 127.0.0.1 --port 5173

3. Open http://127.0.0.1:5173/ in your browser.

Vite handles the /callback route for the OAuth return. Do not open the HTML file directly from disk.

## Spotify details

| Setting | Value |
| --- | --- |
| Client ID | Configured in **app.js** |
| Client Secret | Not used (never commit a client secret) |
| Authentication | OAuth 2.0 Authorization Code with PKCE |
| Hosted OAuth redirect | https://monkeymansilly1.github.io/Swipeify/ |
| Local OAuth redirect | http://127.0.0.1:5173/callback |
| Playback | Spotify Web Playback SDK / Spotify Connect |
| Discovery | Spotify Search + available top artists, songs and listening history |
| Likes | 2026 library endpoint, PUT /v1/me/library with URI query parameter |

Spotify Development Mode currently requires an active Premium subscription and is limited to a small number of authorised users. This is a noncommercial personal project.

## Troubleshooting

- **INVALID_CLIENT or INVALID_REDIRECT_URI:** the exact deployed URL must be saved in the Spotify Developer Dashboard. Capitalisation and the trailing slash matter. Locally, use 127.0.0.1, not a different hostname.
- **Spotify 403:** check user authorisation and your app's Development Mode restrictions.
- **No playback:** click ▶, allow encrypted media in the browser, and try Chrome or Edge. Mobile browsers may block automatic playback until a user gesture.
- **No songs found:** try another genre or reset Swipeify's discovery history. Search may not find all niche music tagged to a particular genre.
- **Liked Song save failed:** the swipe is retained locally, but Spotify may have denied saving. Reconnect and check that you approved the library-modify scope.
- **Reconnect required after a session:** OAuth tokens are kept in session storage in your browser tab, not a remote server.

### Privacy / behaviour

- Your client ID is a **public OAuth identifier**, not a secret.
- Session tokens are stored in browser session storage; swipes, genre choices and bookmarks are stored locally in that browser.
- Bookmarks don't sync to Spotify; right-swiping saves to Spotify Liked Songs.
- Undo restores the previous recommendation, but does not automatically remove a song already saved to Spotify.
- The Spotify Web Playback SDK requires Premium and a supported secure browser context; some mobile devices need an extra tap to begin playback.
- Spotify platform policies prohibit some commercial and modified-playback uses.

Made for discovering music one swipe at a time.
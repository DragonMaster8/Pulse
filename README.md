# Pulse — A Frontend-only API Client

A modern, single-page Postman alternative that runs entirely in the browser. No backend, no build step, no dependencies. Just three files you can drop on GitHub Pages.

![Made with HTML/CSS/JS](https://img.shields.io/badge/stack-HTML%20%2F%20CSS%20%2F%20JS-6366f1) ![No build](https://img.shields.io/badge/build-none-10b981) ![GitHub Pages ready](https://img.shields.io/badge/deploy-GitHub%20Pages-3b82f6)

## Features

- **All major HTTP methods** — GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD
- **Request builder** — URL, query parameters, headers, body (raw JSON, `form-data`, `x-www-form-urlencoded`)
- **Rich response view** — status badge, response time, size, headers table, JSON pretty-print with syntax highlighting
- **Environment variables** — define once, reference anywhere with `{{variable_name}}` (URL, headers, params, body)
- **Request history** — saved to `localStorage`, searchable, click to reload, individually deletable
- **Import / export** — share request collections as a single JSON file
- **cURL preview** — auto-generated `curl` command for any request, one-click copy
- **JSON beautifier** with live validation
- **Dark and light themes** with a soft glassmorphism aesthetic
- **Keyboard shortcut** — `Ctrl/Cmd + Enter` sends the current request
- **Fully responsive** — works on phones, tablets, and desktops
- **Zero dependencies** — pure HTML, CSS, and JavaScript using the Fetch API

## Project structure

```
api/
├── index.html      Markup and layout
├── styles.css      Theme tokens, glassmorphism, responsive layout, animations
├── script.js       App logic: request engine, editors, history, env vars, JSON highlighter
└── README.md       This file
```

## Run locally

Because everything is static, you can just open `index.html` in a modern browser. For best results (and to avoid any `file://` quirks with `localStorage` or clipboard), serve the folder over HTTP:

```bash
# Python 3
python -m http.server 8080

# Node (if installed)
npx serve .
```

Then open <http://localhost:8080>.

## Deploy to GitHub Pages

1. **Create a repository** on GitHub and push these three files (plus this README) to the `main` branch.

   ```bash
   git init
   git add index.html styles.css script.js README.md
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```

2. **Enable GitHub Pages**:
   - Open your repo on GitHub
   - Settings → **Pages**
   - Under *Source*, choose **Deploy from a branch**
   - Branch: **`main`**, Folder: **`/ (root)`**
   - Click **Save**

3. **Wait ~30 seconds**, then visit:

   ```
   https://<your-username>.github.io/<your-repo>/
   ```

That's it. Pushing new commits to `main` automatically redeploys.

### Custom domain (optional)

Add a `CNAME` file containing your domain (e.g. `api.example.com`) and configure DNS to point at GitHub Pages. See the [official docs](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site).

## Using environment variables

1. Open the **Variables** tab.
2. Add a row, e.g. key `base_url`, value `https://jsonplaceholder.typicode.com`.
3. In your URL field, type `{{base_url}}/todos/1`.
4. Variables are also expanded inside header values, parameter values, and JSON bodies.

Variables persist in `localStorage` so they're available across sessions. Use **Export** to share them with teammates as a JSON file.

## Smart Mode (CORS, proxies, auto-headers)

Because Pulse runs in a browser, it's bound by the same-origin policy — APIs that don't include `Access-Control-Allow-Origin` headers can't be read by JavaScript. Postman doesn't have this problem because it's a desktop app.

To make Pulse "just work" anyway, **Smart Mode is on by default** and does three things:

1. **Auto-adds basic headers** — `Accept: */*` is added when you haven't specified one. JSON / urlencoded bodies get the right `Content-Type` automatically.
2. **Auto-retries through a CORS proxy** — if the direct fetch fails (CORS, network, mixed content), Pulse transparently re-issues the request through a configurable public proxy and shows a small **"via proxy"** badge on the response.
3. **Always-proxy mode** — useful behind strict corporate firewalls; skip the direct attempt entirely.

Open **Settings** (gear icon, top-right) to toggle these or pick the proxy provider. Built-in choices:

- `corsproxy.io` — recommended default, handles preflights, no rate limit known
- `api.allorigins.win`
- `api.codetabs.com`
- **Custom** — provide your own template using `{url}` as the encoded-URL placeholder, e.g. a Cloudflare Worker:
  ```
  https://my-worker.example.workers.dev/?url={url}
  ```

> Public CORS proxies see your headers and bodies. **Don't use them for production credentials.** For real work, host a 30-line proxy on Cloudflare Workers, Vercel Edge, or a tiny Node server — it's free and takes minutes.

The auto-generated **cURL** preview always shows the *original* request (not the proxied one), so you can copy-paste it into a terminal verbatim.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl` / `Cmd` + `Enter` | Send the current request |
| `Tab` (in JSON editor) | Insert two spaces |

## Browser support

Tested on the latest versions of Chrome, Edge, Firefox, and Safari. Uses standard Fetch API, `URL`, `URLSearchParams`, `FormData`, and the Clipboard API — all baseline modern web platform features.

## License

MIT — use it, fork it, ship it.

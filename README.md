# Nuvio Backup & Transfer

Static web app to back up a Nuvio account to a JSON file, or copy it into another Nuvio account, profile by profile.

Runs entirely in the browser: it finds the backend via `https://<server>/.well-known/nuvio` (default `api.nuvio.tv`) and calls the
same Supabase RPCs the Nuvio app uses. There's no server of our own, and passwords only go to the Nuvio server.

## Run

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

Any static host (GitHub Pages, Netlify, …) works too. It has to be served over http(s), because ES modules don't load from `file://`.

## What it copies

Addons, plugins, watch progress, watched history, library, collections, app/home settings, and (opt-in, since they hold secrets)
debrid API keys and media-server logins.

How merging works: whatever the destination already has stays. Missing items get added. Watch progress gets overwritten only when
the source copy is newer. Settings are the one exception: they replace the destination's settings. Running a transfer twice is safe.

## Test

```sh
node nuvio.test.mjs
```

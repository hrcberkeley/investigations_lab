# HRC Translate (On-device, No Backend)

This is a static web app that runs translation *in the browser* using **Transformers.js** and Meta's **NLLB-200** model.

It ensures 100% privacy as no data is sent to the cloud.

## What’s inside

- `index.html` — UI (UC Berkeley-inspired colors)
- `styles.css` — styling
- `app.js` — main logic (loads worker, handles UI)
- `worker.js` — web worker that runs the Transformers.js pipeline
- `languages.json` — list of supported NLLB-200 languages

## Supported Languages

The app supports **200+ languages** via the `NLLB-200-distilled-600M` model.

## Run locally

Run a tiny local server to serve the module worker:

```bash
python3 -m http.server 8000
```

Then open:

- http://localhost:8000

## Deploy

Host the folder on any static host (GitHub Pages, Netlify, your own server, etc).
The first time a user visits, the browser will download the model (~100MB+ for the quantized version) and cache it.

## License

MIT.

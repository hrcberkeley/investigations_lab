# Investigations Lab Kit

Worksheets and open tools from ten years (2016–2026) of the [Human Rights Center Investigations Lab](https://humanrights.berkeley.edu/investigations-lab/) at UC Berkeley, shared so other labs can start their own.

The kit follows the stages of an investigation (Frame, Find, Preserve, Verify, Analyze, Protect), and each stage brings together the worksheets we use to teach the method and the tools we've built to make the work easier.

## Run it

It's a static site with no build step. Serve the folder over HTTP (the page reads `content.json`, which browsers won't load from `file://`):

```sh
python3 -m http.server 8765
```

Then open http://localhost:8765. Any static host works too, GitHub Pages included.

## What's here

| Path | What it is |
| --- | --- |
| `index.html`, `style.css`, `app.js` | The homepage. `app.js` renders everything from `content.json` and runs the hero. |
| `content.json` | The single list of stages, worksheets, tools and investigations. |
| `sheets/` | The worksheets, as Word documents and as web pages built from them. After changing a `.docx` or a worksheet entry, run `python3 sheets/build.py` (needs [pandoc](https://pandoc.org)). |
| `tools/` | The browser tools. Each folder is self-contained and opens on its own. |

The Chrome extensions and desktop apps (Sidekick, Canary, Save to Sheets, HRC Archiver) live in their own repositories. The page links to them.

## Adding something

Add an entry to `content.json` and reload the page. Nothing else needs to change.

- **Worksheet:** `id`, `stage`, `title`, `version`, `summary`, and `file` (`sheets/<id>.docx`). Then run `python3 sheets/build.py` to make its page.
- **Tool:** `id`, `stage`, `kind` (`browser`, `extension` or `desktop`), `name`, `summary`, and `launch` (path under `tools/`), `source` (a repository URL), or both.
- **Investigation:** `title` and `url`.

`stage` is one of the `id`s in `stages`.

## Models

The browser tools run their machine-learning models on your own device. The files you load into them never leave your machine. Small models are included here. Larger ones download from Hugging Face the first time you use them, then come from the browser's cache:

- **Jepa! Jepa!** loads I-JEPA ViT-H/14 (`onnx-community/ijepa_vith14_1k`, about 600 MB).
- **Censorama**'s YOLO26 and RF-DETR models load from Hugging Face. YOLO11n and YOLO11s are bundled. The legacy YOLO11m option was removed to keep the repository small.
- **Videologue**, **Translate**, **Transcribe**, **B-RAG** and **EmbedScape** fetch their models from Hugging Face or Google's MediaPipe CDN.

## A note on the tools

These are prototypes. They work, but treat them as demonstrations of what current technology makes possible, and check what they produce.

# Kiln

**Browser-based satellite embedding similarity search & change detection, powered by the Clay foundation model.**

Kiln lets you search the Earth's surface the way you'd search a text corpus. Draw an
area anywhere in the world, load its precomputed AI embeddings, then find other
locations that *look similar* to one you pick — or detect where the surface
*changed* between two dates. Everything runs in your browser; the only network
traffic is range requests to a public dataset.

It was built for investigative journalism, environmental monitoring, and
remote-sensing research — tasks where you need to find analogous facilities, map
a land-cover transition, or scan a region for unusual change without writing any
code.

---

## How it works

Kiln sits on top of a public dataset of precomputed embeddings produced by
**Clay**, an open-source Earth-observation foundation model (Clay v1.5, a
632-million-parameter Vision Transformer trained by LGND AI on hundreds of
millions of Sentinel-2 multispectral tiles). Each 1280-meter cell of the globe
that has clear imagery is encoded into a compact **256-dimensional embedding** —
a numeric fingerprint of what that place looks like at a given moment. Because
similar-looking places produce similar embeddings, you can find global matches
to any reference location by comparing vectors. No training, no labels, no GPU
required.

The embeddings are published as Parquet files on **Source Cooperative**
(`data.source.coop/clay/lgnd-embeddings/`), organized on the MajorTOM 1280-meter
grid as monthly snapshots. Kiln never downloads a whole file: each Parquet file
is split into row groups of roughly 126&nbsp;MB compressed, and Kiln fetches
**only the row groups whose bounding box overlaps your drawn area**. You see a
cost estimate before anything is downloaded.

All computation — decoding, similarity, change, probe training — happens locally
in Web Workers. No data leaves your machine.

---

## Features

### Three analysis modes

- **Similarity** — Click any chip on the map as your reference site. Kiln
  instantly ranks every loaded chip by cosine similarity to it. Use this to find
  industrial facilities that match a known type, identify terrain analogues, or
  locate patterns of interest across a region.
- **Change detection** — Load the same area for two time periods and compute how
  much each cell shifted between snapshots. Cells are colored by magnitude of
  change in embedding space — a reliable proxy for construction, deforestation,
  flooding, or other land-cover transitions.
  - **Change-analog search:** after a change run, click any changed cell and find
    everywhere that underwent the *same kind* of transition — useful for mapping
    a process (e.g. vegetation → bare earth) across a wide region.
- **Concept probe** — Teach the tool a concept by example. Paint a handful of
  chips that *are* the thing you're after (e.g. a tailings pond) and a handful
  that are *not*, then train. Kiln fits a small logistic-regression classifier on
  the embeddings in your browser in milliseconds and scores every loaded chip by
  how well it matches the concept you defined. Tick *Show only held-out regions*
  to train on one region and evaluate on another for an honest test.

### Workflow

1. **Navigate** — jump to a location by name (geocoded via OpenStreetMap
   Nominatim) or by coordinates.
2. **Draw an area** — drag a rectangle on the map.
3. **Load data** — pick a time period, review the download cost estimate, and
   confirm. Embeddings stream in with a live progress bar.
4. **Analyze** — switch between Similarity / Change / Concept modes.
5. **Export** — save results as GeoJSON or CSV, or save the full session to JSON
   and reload it later.

### Other niceties

- Temporal analysis timeline chart per reference chip.
- Adjustable similarity / change / match thresholds with live map filtering.
- Ranked results list with one-click reference promotion.
- Per-region load management (release a region to free memory).
- Reference picker that lets you choose among the snapshots available at a
  clicked location.
- Coordinate readout, similarity legend, and an in-app About modal with a score
  interpretation table.

---

## Interpreting scores

Similarity scores are **cosine similarity** between two 256-dimensional unit
vectors. Treat them as *relative rankings* within a result set, not absolute
thresholds.

| Score range | What it means |
|-------------|---------------|
| 0.92 – 1.00 | Very high similarity — near-identical land surface character. Strong match. |
| 0.80 – 0.91 | High similarity — same broad land-cover class with noticeable variation. |
| 0.65 – 0.79 | Moderate — related but distinct character. Worth reviewing. |
| &lt; 0.65 | Likely dissimilar — treat as a weak or coincidental match. |

For change detection, scores represent cosine distance (how much the embedding
shifted), so **higher means more change**. The default sliders filter out chips
below threshold on the map; the chips remain in memory and reappear if you lower
the threshold.

---

## Coverage

The dataset is populated incrementally. The Americas and Pacific are
well-covered; other regions may show "no data available" as more tiles are
added. **A missing tile is normal, not a tool error** — you can navigate
anywhere in the world, and areas without data report a clear message instead of
failing. Snapshots currently center on June 2024, June 2025, and June 2026.

---

## Technical details

### Architecture

Kiln is a static site — a single `index.html` plus prebuilt JS/CSS bundles in
`assets/`. There is no backend and no build step to run it.

- **Map rendering:** MapLibre GL JS (v5.24.0) over Esri World Imagery, with
  ArcGIS boundary/place reference overlays.
- **Parquet decoding:** a custom `decode-worker` reads Parquet directly over
  HTTP, performing byte-range fetches at the row-group level and decoding with
  Snappy, Gzip, Brotli, Zstd, LZ4, and LZ4_RAW codecs.
- **Similarity:** a dedicated `similarity-worker` computes cosine similarity of
  the reference vector against every loaded chip.
- **Concept probe:** a `probe-worker` fits logistic regression (300 iterations,
  learning rate 0.5, L2 0.1) on labeled embeddings and scores the region.
- **Manifest:** `manifest.json` maps the grid (per MajorTOM cell, per month) to
  Parquet file hashes and byte lengths so Kiln can plan minimal range fetches.

### Privacy

All computation runs in your browser. The only outbound traffic is HTTP range
requests to public cloud storage (Source Cooperative for embeddings, Esri/ArcGIS
for basemap tiles, OpenStreetMap Nominatim for geocoding, and the Element 84
STAC catalog for scene metadata). No embeddings or query data leave your machine.

### Running it

Serve the directory over HTTP (the app fetches Parquet via range requests, so
`file://` won't work):

```bash
cd Kiln
python -m http.server 8080
# open http://localhost:8080
```

A modern browser (Chrome, Firefox, or Edge) with Web Workers and
`SharedArrayBuffer`/COOP-COEP is recommended for the heavier Parquet decode
paths.

---

## Acknowledgments

- **Clay** foundation model and embeddings — [Clay Foundation](https://clay-foundation.github.io/model/) / LGND AI.
- Embeddings hosted on **Source Cooperative**, organized on the **MajorTOM** grid.
- **MapLibre GL JS**, **Esri/ArcGIS** imagery, **OpenStreetMap/Nominatim**, and
  the **Element 84** Earth Search STAC catalog.

---

Made by **Guillen Torres** — comments welcome at info@osinv.org.

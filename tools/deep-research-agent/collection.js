// ============================================================
// COLLECTION LANE — Browser port of perry-v2's collection mode.
//
// What this does, in plain language:
//   The user describes a *target* (e.g. "links to PDFs containing
//   'congressional budget justification' for 2026") and a small table
//   schema (column names + kinds). Instead of writing a sectioned
//   report, we enumerate matching items from web sources into a table.
//
// Pipeline (sequential, browser-safe):
//   1. queryGen     - expand user templates or LLM-generate Brave queries
//   2. search       - Brave Search via the existing tools registry
//   3. triage       - per-result "could this contain the target?" yes/no
//                     (substring pre-filter using corpus_filter, then LLM)
//   4. fetch        - HTML via the existing CORS-worker fetcher
//   5. retrieve     - pick passages (anchor / top-N / whole)
//   6. extract      - one LLM call per source → JSON rows, one per unit
//   7. dedup        - post-extraction deduplication by body-column values
//   8. audit        - render source audit + collection diagnostics summary
//
// All LLM calls go through a `generateText(systemPrompt, userMessage, maxTokens)`
// function passed in by the host page (index.html). The host also supplies
// a `tools` instance (ToolRegistry) and a small `ui` object with callbacks
// for progress messages and live table updates.
// ============================================================

const DEFAULT_EXTRACTION_PROMPT =
  'For each column, extract the most precise value available from the text. ' +
  'Preserve specific dates, names, and figures exactly as stated. ' +
  'Use "unknown" only when the value is genuinely absent from the source. ' +
  'Do not infer or guess values not present in the text.';

const UNIT_GUIDANCE = {
  source:
    'Collection unit: SOURCE. Emit ONE row when the page itself matches the target. Do not emit one row per mention.',
  passage:
    'Collection unit: PASSAGE. Emit one row per relevant passage or paragraph that matches the target.',
  entity:
    'Collection unit: ENTITY. Emit one row per distinct entity (person, organization, place, product) matching the target.',
  event:
    'Collection unit: EVENT. Emit one row per discrete event, decision, deadline, or dated development matching the target.',
  claim:
    'Collection unit: CLAIM. Emit one row per factual statement, quotation, or claim matching the target.',
  auto:
    'Collection unit: AUTO. Infer from the target: SOURCE for URL/document asks, ENTITY for people/orgs/places, CLAIM for statements, EVENT for actions, PASSAGE for broader excerpts.',
};

// ------------------------------------------------------------
// Public entry point. Returns the final row count when done.
//
// ctx.ui must provide:
//   system(msg)             — status messages
//   phase(label, detail)    — phase header
//   appendRow(row)          — live table append (before dedup)
//   clearTable()            — reset the table
//   finalizeRows(rows, summary) — called once after dedup with audit data
//
// All intermediate rows are appended live for responsiveness;
// after all queries complete a dedup pass runs and the host
// re-renders the final deduplicated set alongside source audit
// and collection diagnostics (mirroring perry-v2 aggregation phase).
// ------------------------------------------------------------
export async function runCollection(cfg, ctx) {
  const { tools, generateText, ui } = ctx;

  // Reset working state — collection runs are independent from research.
  tools.clearState();
  ui.clearTable();

  // ---------- 1. Generate or expand queries ----------
  const queries = await buildQueries(cfg, ctx);
  if (!queries.length) {
    ui.system('No search queries produced — aborting.');
    return;
  }
  ui.system(`📋 Queries: ${queries.join(' · ')}`);

  // Accumulate all rows before deduplication so we can run a final
  // dedup pass across the entire result set (matching v2 aggregation).
  const allRows = [];

  // Per-source outcome log — powers the Source Audit table.
  // Each entry: { title, url, outcome, rowsExtracted }
  // outcome: 'triaged_skip' | 'corpus_filter_skip' | 'fetched_no_rows' | 'used' | 'error'
  const sourceLog = [];

  // Parse failures — populated when JSON extraction returns unparseable output.
  // Each entry: { source, error }
  const parseFailures = [];

  for (const query of queries) {
    if (ctx.shouldStop?.()) break;
    ui.phase(`🔍 Search`, query);

    // ---------- 2. Search ----------
    // Fetch 20 results per page across 2 pages (= up to 40 candidates).
    const search = await tools.braveWebSearch({ query, count: 20, pages: 2 });
    if (search.error) { ui.system(`Search error: ${search.error}`); continue; }
    if (!search.items?.length) continue;

    // ---------- 3. Triage ----------
    const accepted = await triageResults(search.items, cfg, ctx);

    // Log every triaged-out result so the source audit is complete.
    const acceptedUrls = new Set(accepted.map(i => i.link));
    for (const item of search.items) {
      if (!acceptedUrls.has(item.link)) {
        sourceLog.push({ title: item.title || item.link, url: item.link, outcome: 'triaged_skip', rowsExtracted: 0 });
      }
    }
    ui.system(`✓ ${accepted.length}/${search.items.length} results passed triage.`);

    // ---------- 4–6. Fetch, retrieve, extract (concurrency-limited) ----------
    const { rows, log, failures } = await processSources(accepted, cfg, ctx);
    allRows.push(...rows);
    sourceLog.push(...log);
    parseFailures.push(...failures);

    // Append rows live so the user sees progress as they arrive.
    for (const row of rows) ui.appendRow(row);

    ui.system(`📊 Running total: ${allRows.length} rows.`);
  }

  // ---------- 7. Deduplication ----------
  // Remove rows whose body-column values are identical (case-insensitive).
  // Mirrors perry-v2's run_collection_aggregation_phase dedup logic.
  const { deduped, removed } = deduplicateRows(allRows, cfg);

  ui.phase('✅ Collection complete', `${deduped.length} rows${removed ? ` (${removed} duplicate${removed > 1 ? 's' : ''} removed)` : ''}.`);

  // ---------- 8. Finalize — re-render deduped table + show audit ----------
  ui.finalizeRows(deduped, {
    target: cfg.target,
    sourceLog,
    parseFailures,
    totalRows: deduped.length,
    rowsBeforeDedup: allRows.length,
    rowsRemoved: removed,
  });

  return deduped.length;
}

// ------------------------------------------------------------
// Step 1: build the search-query list.
// If the user typed any templates we expand them; otherwise we
// ask the LLM for n queries that are good at *locating sources*
// containing the target (very different from Q&A queries).
// ------------------------------------------------------------
async function buildQueries(cfg, ctx) {
  const { target, queryTemplates = [], numQueries = 5, chunkAnchor } = cfg;
  const past = new Set(ctx.tools.getPastQueries().map(q => q.toLowerCase()));

  // Template expansion — no LLM needed when the user knows the shape.
  if (queryTemplates.length) {
    const expanded = queryTemplates
      .map(t => t.replace(/\{target\}/g, target).replace(/\{anchor\}/g, chunkAnchor || ''))
      .map(q => q.trim())
      .filter(Boolean)
      .filter(q => !past.has(q.toLowerCase()))
      .slice(0, numQueries);
    if (expanded.length) return expanded;
  }

  const anchorClause = chunkAnchor
    ? ` co-occurring with the phrase or entity "${chunkAnchor}"`
    : '';

  const system =
    `You are a search specialist helping locate web sources for a data collection task. ` +
    `Your goal is to find pages, documents, or datasets that contain instances of: "${target}"${anchorClause}.\n\n` +
    `Generate exactly ${numQueries} short Brave Search queries designed to surface the most ` +
    `relevant sources. Prefer quoted phrases, specific terminology, or operators that narrow ` +
    `results (e.g. filetype:pdf, site:gov). One query per line. No numbering. No explanation. ` +
    `No trailing punctuation.`;

  const user = `Collection target: ${target}\n\nSearch queries:`;
  const raw = await ctx.generateText(system, user, 200);
  return raw
    .split('\n')
    .map(line => line.trim().replace(/^[\d.\-)\s"']+|["']$/g, '').trim())
    .filter(q => q.length > 5 && !/^queries?:/i.test(q) && !/^search queries/i.test(q))
    .filter(q => !past.has(q.toLowerCase()))
    .slice(0, numQueries);
}

// ------------------------------------------------------------
// Step 3: triage. Two cheap filters first; only call the LLM
// when neither filter has already made the call.
//
// Stage 1 — corpus_filter snippet pre-check: if the filter phrase
//   is absent from title+snippet (and snippet is long enough that
//   absence is meaningful), drop without an LLM call. This mirrors
//   perry-v2 collection_triage.rs pre-filter.
// Stage 2 — LLM yes/no: "could this source plausibly contain
//   the target?" One call per result. Returns READ or SKIP.
// ------------------------------------------------------------
async function triageResults(items, cfg, ctx) {
  const { target, corpusFilter } = cfg;
  const filter = (corpusFilter || '').trim().toLowerCase();
  const accepted = [];

  for (const item of items) {
    if (ctx.shouldStop?.()) break;
    const combined = `${item.title || ''} ${item.snippet || ''}`.toLowerCase();

    // Stage 1: Cheap substring pre-filter on snippet before any fetching.
    // Only skip when snippet is long enough that absence is meaningful.
    if (filter && item.snippet && item.snippet.length > 80 && !combined.includes(filter)) {
      continue;
    }

    // Stage 2: LLM yes/no triage
    const decision = await llmTriageOne(item, target, ctx);
    if (decision) accepted.push(item);
  }

  return accepted;
}

async function llmTriageOne(item, target, ctx) {
  const system =
    `You filter web search results for a data collection task. ` +
    `Decide whether a single result could plausibly contain instances of the target. ` +
    `Reply with exactly one word: READ if it could plausibly contain the target, ` +
    `SKIP if the title/URL/snippet show it is off-topic, an ad, a login page, an ` +
    `unrelated social profile, or a generic category page.`;
  const user =
    `Target: ${target}\n\n` +
    `Title: ${item.title || ''}\n` +
    `URL: ${item.link || ''}\n` +
    `Snippet: ${item.snippet || ''}\n\n` +
    `Decision:`;
  try {
    const raw = await ctx.generateText(system, user, 8);
    return /^read\b/i.test(raw.trim());
  } catch (e) {
    // If the model fails, default to READ so we don't silently drop everything.
    console.warn('Triage failed, defaulting to READ:', e);
    return true;
  }
}

// ------------------------------------------------------------
// Steps 4–6: fetch, retrieve passages, extract rows.
// Concurrency-limited pool of 3 — keeps the proxy + WebGPU happy.
// Returns { rows[], log[], failures[] } for the caller to merge
// into the run-level accumulators.
// ------------------------------------------------------------
async function processSources(sources, cfg, ctx) {
  const pool = 3;
  const result = { rows: [], log: [], failures: [] };
  let i = 0;

  async function worker() {
    while (i < sources.length) {
      if (ctx.shouldStop?.()) return;
      const item = sources[i++];
      try {
        const r = await processOneSource(item, cfg, ctx);
        result.rows.push(...r.rows);
        result.log.push(r.logEntry);
        if (r.parseFailure) result.failures.push(r.parseFailure);
      } catch (e) {
        console.warn('Source failed:', item?.link, e);
        result.log.push({
          title: item?.title || item?.link || 'unknown',
          url: item?.link || '',
          outcome: 'error',
          rowsExtracted: 0,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: pool }, worker));
  return result;
}

async function processOneSource(item, cfg, ctx) {
  const { tools, ui } = ctx;
  const url = item.link;
  ui.system(`📄 Reading: ${url}`);

  // Each source gets a log entry tracking its pipeline outcome.
  const logEntry = { title: item.title || url, url, outcome: 'fetched_no_rows', rowsExtracted: 0 };

  // Step 4: fetch
  const fetched = await tools.fetchUrl({ url });
  if (fetched.skipped || !fetched.content || fetched.content.length < 200) {
    return { rows: [], logEntry, parseFailure: null };
  }

  // corpus_filter applied to full text. Post-fetch gate before extraction.
  const filter = (cfg.corpusFilter || '').trim().toLowerCase();
  if (filter && !fetched.content.toLowerCase().includes(filter)) {
    ui.system(`✗ Corpus filter absent in ${safeHost(url)} — skipping.`);
    logEntry.outcome = 'corpus_filter_skip';
    return { rows: [], logEntry, parseFailure: null };
  }

  // Step 5: retrieve passages
  const passages = await pickPassages(fetched.content, cfg, ctx);
  if (!passages.length) return { rows: [], logEntry, parseFailure: null };

  // Step 6: extract rows (one LLM call per joined passage block)
  const bodyCols = cfg.columns.filter(c => c.kind === 'body').map(c => c.name);
  const passageText = passages.join('\n\n').slice(0, 6000);

  // If there are no Body columns, the row is pure metadata — skip the LLM.
  let extractedRows = [];
  let parseFailure = null;

  if (bodyCols.length === 0) {
    extractedRows = [{}];
  } else {
    const extraction = await extractRows({
      target: cfg.target,
      unit: cfg.collectionUnit || 'auto',
      bodyCols,
      passageText,
      sourceTitle: item.title || '',
      sourceUrl: url,
      extractionPrompt: cfg.extractionPrompt || DEFAULT_EXTRACTION_PROMPT,
    }, ctx);
    extractedRows = extraction.rows;
    if (extraction.parseFailure) {
      parseFailure = { source: item.title || url, error: extraction.parseFailure };
    }
  }

  if (!extractedRows.length) return { rows: [], logEntry, parseFailure };

  // Step 7: build and validate rows
  const finalRows = [];
  for (const partial of extractedRows) {
    const row = buildRow(partial, item, cfg);
    if (!hasUsableContent(row, cfg)) continue;
    await tools.saveCollectionItem(row);
    finalRows.push(row);
  }

  if (finalRows.length > 0) {
    logEntry.outcome = 'used';
    logEntry.rowsExtracted = finalRows.length;
  }

  return { rows: finalRows, logEntry, parseFailure };
}

// ------------------------------------------------------------
// Passage selection. Three strategies, matching perry-v2:
//   - anchor_chunks  → keep only chunks containing chunk_anchor
//   - whole_document → every chunk (capped) goes to the extractor
//   - top_n_relevant / auto → top-N by cosine similarity to target
// ------------------------------------------------------------
async function pickPassages(text, cfg, ctx) {
  const { tools } = ctx;
  const { chunks } = tools.chunkText({ text, chunk_size: 900, overlap: 120 });
  if (!chunks.length) return [];

  const strategy = cfg.retrievalStrategy || 'auto';
  const anchor = (cfg.chunkAnchor || '').trim().toLowerCase();

  if (strategy === 'anchor_chunks' || (strategy === 'auto' && anchor)) {
    if (!anchor) return chunks.slice(0, 5).map(c => c.text);
    const hits = chunks.filter(c => c.text.toLowerCase().includes(anchor));
    return hits.slice(0, 6).map(c => c.text);
  }

  if (strategy === 'whole_document') {
    return chunks.slice(0, 10).map(c => c.text);
  }

  // top_n_relevant / auto (no anchor)
  if (!tools.embedder) return chunks.slice(0, 5).map(c => c.text);
  const targetVec = await tools.embedText(cfg.target);
  const scored = [];
  for (const c of chunks) {
    const v = await tools.embedText(c.text);
    scored.push({ text: c.text, score: tools._cosineSimilarity(targetVec, v) });
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored[0].score < 0.2) return []; // genuinely off-topic source
  return scored.slice(0, 5).map(s => s.text);
}

// ------------------------------------------------------------
// LLM row extraction. We ask the model for `{"rows":[{...}, ...]}`
// where each row object has exactly the requested Body columns.
// Returns { rows[], parseFailure } so the caller can track failures.
// ------------------------------------------------------------
async function extractRows({ target, unit, bodyCols, passageText, sourceTitle, sourceUrl, extractionPrompt }, ctx) {
  const colList = bodyCols.map((c, i) => `  ${i + 1}. "${c}"`).join('\n');
  const exampleObj = bodyCols.map(c => `"${c}": "..."`).join(', ');

  const system =
    `You are a data collection assistant. Collect data about: "${target}".\n\n` +
    `${UNIT_GUIDANCE[unit] || UNIT_GUIDANCE.auto}\n\n` +
    `Output strict JSON with this exact shape:\n` +
    `{"rows":[{${exampleObj}}]}\n\n` +
    `Each row object must contain EXACTLY these keys (no extra keys, no missing keys):\n` +
    `${colList}\n\n` +
    `Rules:\n` +
    `- Use only the Source text below. Do not use prior knowledge.\n` +
    `- Each value must be factual, concise, under 240 characters.\n` +
    `- Use "unknown" only when the value is genuinely absent from the source.\n` +
    `- Return {"rows":[]} only when the source is genuinely irrelevant.\n` +
    `- Output JSON only — no preamble, no explanation, no trailing text.\n\n` +
    `Extraction guidance: ${extractionPrompt}`;

  const user =
    `Source: ${sourceTitle} (${sourceUrl})\n` +
    `Text:\n${passageText}\n\n` +
    `Emit the JSON now:`;

  const raw = await ctx.generateText(system, user, 600);
  return parseRowsResponse(raw, bodyCols);
}

// Defensive JSON parsing. The model often wraps JSON in prose or
// closes it with `<end_of_turn>`. We try several recovery paths and
// report the failure reason so it can appear in the diagnostics section.
function parseRowsResponse(raw, bodyCols) {
  if (!raw) return { rows: [], parseFailure: 'Empty model response' };
  const cleaned = raw
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .replace(/<[^>]{1,30}>/g, '')
    .trim();

  // 1. Strict parse
  try {
    const obj = JSON.parse(cleaned);
    return { rows: coerceRows(obj, bodyCols), parseFailure: null };
  } catch { /* fall through */ }

  // 2. Pull the largest {...} block
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0]);
      return { rows: coerceRows(obj, bodyCols), parseFailure: null };
    } catch { /* fall through */ }
  }

  // 3. Pull the largest [...] block and treat as rows
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const arr = JSON.parse(arrMatch[0]);
      return { rows: coerceRows({ rows: arr }, bodyCols), parseFailure: null };
    } catch { /* give up */ }
  }

  return { rows: [], parseFailure: cleaned.slice(0, 120) };
}

function coerceRows(obj, bodyCols) {
  let rows = [];
  if (Array.isArray(obj)) rows = obj;
  else if (obj && Array.isArray(obj.rows)) rows = obj.rows;
  else if (obj && typeof obj === 'object') rows = [obj];
  return rows
    .filter(r => r && typeof r === 'object')
    .map(r => {
      const clean = {};
      for (const col of bodyCols) {
        const v = r[col];
        clean[col] = v == null ? 'unknown' : String(v).slice(0, 240);
      }
      return clean;
    })
    .filter(r => Object.values(r).some(v => v && v !== 'unknown'));
}

// ------------------------------------------------------------
// Post-extraction deduplication.
// Mirrors perry-v2 run_collection_aggregation_phase dedup logic.
// Key is built from all body-column values joined (case-insensitive).
// For metadata-only rows, falls back to source_url.
// ------------------------------------------------------------
function deduplicateRows(rows, cfg) {
  const bodyCols = cfg.columns.filter(c => c.kind === 'body').map(c => c.name);
  const seen = new Set();
  const deduped = [];
  let removed = 0;

  for (const row of rows) {
    const key = bodyCols.length > 0
      ? bodyCols.map(col => (row.values[col] || '').toLowerCase().trim()).join(' ')
      : row.source_url;

    if (!key || !seen.has(key)) {
      if (key) seen.add(key);
      deduped.push(row);
    } else {
      removed++;
    }
  }

  return { deduped, removed };
}

// ------------------------------------------------------------
// Build the final row by merging body-column values with the
// auto-filled metadata columns (source_url / source_title / domain).
// ------------------------------------------------------------
function buildRow(partial, item, cfg) {
  const row = {
    id: `item_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    target: cfg.target,
    unit: cfg.collectionUnit || 'auto',
    source_url: item.link || '',
    source_title: item.title || '',
    domain: safeHost(item.link || ''),
    values: {},
    timestamp: new Date().toISOString(),
  };

  for (const col of cfg.columns) {
    let val;
    switch (col.kind) {
      case 'source_url':    val = item.link || ''; break;
      case 'source_title':  val = item.title || ''; break;
      case 'source_domain': val = safeHost(item.link || ''); break;
      case 'body':
      default:              val = partial[col.name] ?? 'unknown';
    }
    row.values[col.name] = val;
  }
  return row;
}

// A row is "usable" only if at least one body column has real content.
// Pure-metadata rows (no body columns) are always kept.
function hasUsableContent(row, cfg) {
  const bodyCols = cfg.columns.filter(c => c.kind === 'body').map(c => c.name);
  if (!bodyCols.length) return true;
  return bodyCols.some(name => {
    const v = row.values[name];
    return v && String(v).trim().toLowerCase() !== 'unknown';
  });
}

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

// ------------------------------------------------------------
// Source audit + diagnostics HTML builder.
// Mirrors the markdown blocks perry-v2 appends at report end:
//   ## Collection Diagnostics  (metrics table)
//   ## Source Audit            (per-source outcome table)
// Called by index.html after finalizeRows to inject the summary
// section beneath the live table.
// ------------------------------------------------------------
export function buildCollectionSummary(summary) {
  const { target, sourceLog, parseFailures, totalRows, rowsBeforeDedup, rowsRemoved } = summary;

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ---- Diagnostics table ----
  const used = sourceLog.filter(s => s.outcome === 'used').length;
  const fetchedNoRows = sourceLog.filter(s => s.outcome === 'fetched_no_rows').length;
  const triagedSkip = sourceLog.filter(s => s.outcome === 'triaged_skip').length;
  const corpusSkip = sourceLog.filter(s => s.outcome === 'corpus_filter_skip').length;
  const errors = sourceLog.filter(s => s.outcome === 'error').length;

  const diagRows = [
    ['Sources searched', sourceLog.length],
    ['Sources that passed triage', sourceLog.length - triagedSkip],
    ['Sources that yielded rows', used],
    ['Sources fetched, no rows', fetchedNoRows],
    ['Sources skipped (triage)', triagedSkip],
    rowsRemoved > 0 ? ['Rows before deduplication', rowsBeforeDedup] : null,
    rowsRemoved > 0 ? ['Duplicate rows removed', rowsRemoved] : null,
    ['Final rows', totalRows],
    parseFailures.length > 0 ? ['Parse failures', parseFailures.length] : null,
    errors > 0 ? ['Fetch errors', errors] : null,
    corpusSkip > 0 ? ['Skipped (corpus filter)', corpusSkip] : null,
  ].filter(Boolean);

  const diagHtml = `
    <table class="audit-table">
      <thead><tr><th>Metric</th><th style="text-align:right">Count</th></tr></thead>
      <tbody>${diagRows.map(([label, val]) => `<tr><td>${esc(label)}</td><td style="text-align:right">${esc(val)}</td></tr>`).join('')}</tbody>
    </table>`;

  // ---- Parse failures list (up to 12, with overflow) ----
  let failuresHtml = '';
  if (parseFailures.length > 0) {
    const shown = parseFailures.slice(0, 12);
    const overflow = parseFailures.length - shown.length;
    failuresHtml = `
      <div class="audit-subheading">Notes Not Parsed</div>
      <ul class="audit-failure-list">
        ${shown.map(f => `<li><span class="audit-failure-source">${esc(f.source.slice(0, 60))}</span>: ${esc(f.error)}</li>`).join('')}
        ${overflow > 0 ? `<li style="color:var(--text-muted)">…and ${overflow} more</li>` : ''}
      </ul>`;
  }

  // ---- Source Audit table ----
  const outcomeLabel = {
    used: 'used in table',
    fetched_no_rows: 'fetched, no rows',
    triaged_skip: 'searched only',
    corpus_filter_skip: 'corpus filter skip',
    error: 'error',
  };
  const outcomeColor = {
    used: 'var(--accent-green)',
    fetched_no_rows: 'var(--accent-amber)',
    triaged_skip: 'var(--text-muted)',
    corpus_filter_skip: 'var(--text-muted)',
    error: 'var(--accent-red)',
  };

  // Deduplicate audit entries by URL so multi-query results merge cleanly.
  const auditByUrl = new Map();
  for (const s of sourceLog) {
    const existing = auditByUrl.get(s.url);
    if (!existing || s.outcome === 'used') auditByUrl.set(s.url, s);
  }
  const auditEntries = [...auditByUrl.values()];

  const auditRows = auditEntries.map(s => `
    <tr>
      <td><a href="${esc(s.url)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;font-size:0.78rem">${esc((s.title || s.url).slice(0, 70))}</a></td>
      <td style="color:${outcomeColor[s.outcome] || 'var(--text-secondary)'};">${outcomeLabel[s.outcome] || s.outcome}</td>
      <td style="text-align:right">${s.rowsExtracted || '—'}</td>
    </tr>`).join('');

  const auditHtml = `
    <table class="audit-table">
      <thead><tr><th>Source</th><th>Outcome</th><th style="text-align:right">Rows</th></tr></thead>
      <tbody>${auditRows}</tbody>
    </table>`;

  return `
    <div class="collection-summary">
      <div class="audit-section">
        <div class="audit-heading">Collection Diagnostics</div>
        ${diagHtml}
        ${failuresHtml}
      </div>
      <div class="audit-section">
        <div class="audit-heading">Source Audit</div>
        ${auditHtml}
      </div>
    </div>`;
}

// ------------------------------------------------------------
// CSV export — table-of-rows version (different from notes/sources CSV).
// ------------------------------------------------------------
export function rowsToCSV(rows, columns) {
  if (!rows.length) return '';
  const headers = columns.map(c => c.name);
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map(h => esc(r.values[h])).join(','));
  }
  return lines.join('\n');
}

// ============================================================
// DEEP RESEARCH AGENT - Enhanced Tools Module
// Browser-native tool implementations for FunctionGemma 270M
// ============================================================

/**
 * Tool Registry - All available tools and their implementations
 */
export class ToolRegistry {
  constructor(config = {}) {
    this.config = {
      braveApiKey: config.braveApiKey || '',
      // ----------------------------------------------------------------
      // Replace this with your own Cloudflare Worker URL after deploying.
      // See cloudflare-worker/worker.js for instructions.
      // The worker relays requests to Brave Search with proper CORS headers.
      // ----------------------------------------------------------------
      braveSearchEndpoint: config.braveSearchEndpoint || '',
      maxFetchChars: config.maxFetchChars || 8000,
      vectorDimensions: config.vectorDimensions || 384,
      corsProxyUrl: config.corsProxyUrl || '',
      allowedSites: config.allowedSites || [],
    };

    this.sources = [];
    this.notes = [];
    this.readUrls = new Set();
    this.pastQueries = new Set();
    this.vectorStore = new Map();
    this.db = null;
    this.embedder = null;

    this._initIndexedDB();
  }

  async initEmbeddings(pipeline) {
    this.embedder = pipeline;
    console.log('Embedding model initialized');
  }

  // ============================================================
  // INDEXEDDB PERSISTENCE
  // ============================================================

  async _initIndexedDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('DeepResearchAgent', 3);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Store for documents/sources
        if (!db.objectStoreNames.contains('documents')) {
          const docStore = db.createObjectStore('documents', { keyPath: 'id', autoIncrement: true });
          docStore.createIndex('url', 'url', { unique: true });
          docStore.createIndex('timestamp', 'timestamp');
        }

        // Store for notes
        if (!db.objectStoreNames.contains('notes')) {
          const noteStore = db.createObjectStore('notes', { keyPath: 'id', autoIncrement: true });
          noteStore.createIndex('title', 'title');
          noteStore.createIndex('timestamp', 'timestamp');
        }

        // Store for vector embeddings
        if (!db.objectStoreNames.contains('vectors')) {
          const vecStore = db.createObjectStore('vectors', { keyPath: 'id' });
          vecStore.createIndex('docId', 'docId');
        }

        if (!db.objectStoreNames.contains('reports')) {
          const reportStore = db.createObjectStore('reports', { keyPath: 'id' });
          reportStore.createIndex('timestamp', 'timestamp');
          reportStore.createIndex('question', 'question');
        }

        // Collection-mode rows. One record per extracted item; arbitrary
        // user-defined column values live inside `values` as a plain object.
        if (!db.objectStoreNames.contains('collection_items')) {
          const collStore = db.createObjectStore('collection_items', { keyPath: 'id' });
          collStore.createIndex('target', 'target');
          collStore.createIndex('timestamp', 'timestamp');
          collStore.createIndex('source_url', 'source_url');
        }
      };
    });
  }

  // ============================================================
  // BRAVE WEB SEARCH - Implementation
  // ============================================================

  /**
   * Basic Brave Web Search
   */
  // pages: how many Brave pages to fetch per query (each page = up to 20 results).
  // Brave supports offset=0,20,40,... — more pages widens the result pool at the
  // cost of extra API quota. The Brave API often returns fewer results than the
  // consumer UI for operator-heavy queries (e.g. filetype:pdf), so pagination
  // is the only reliable way to recover the missing results.
  async braveWebSearch({ query, count = 20, pages = 2, freshness = null }) {
    if (!this.config.braveApiKey) {
      return { error: "Brave Search API key required.", items: [] };
    }

    const endpoint = "https://api.search.brave.com/res/v1/web/search";
    const effectiveQuery = this._applyAllowedSites(query);
    const perPage = Math.min(20, Math.max(1, count));

    if (this.pastQueries.has(effectiveQuery)) {
      return { error: `Duplicate query: "${effectiveQuery}" was already searched this session. Use a different query.`, items: [], duplicate: true };
    }
    this.pastQueries.add(effectiveQuery);

    const seen = new Set();
    const allItems = [];
    const maxPages = Math.min(Math.max(1, pages), 5); // hard cap at 5 pages

    try {
      for (let page = 0; page < maxPages; page++) {
        const params = new URLSearchParams({
          q: effectiveQuery,
          count: String(perPage),
          offset: String(page), // Brave offset is page index (0–9), not result skip
        });
        if (freshness) params.set('freshness', freshness);

        const data = await this._fetchBrave(endpoint, params);
        const pageResult = this._normalizeBraveResponse(data, effectiveQuery);

        let added = 0;
        for (const item of pageResult.items || []) {
          if (!seen.has(item.link)) {
            seen.add(item.link);
            allItems.push(item);
            added++;
          }
        }

        // Stop early if Brave signals no more results or page returned nothing new.
        const moreAvailable = data?.query?.more_results_available ??
                              data?.web?.more_results_available ?? true;
        if (!moreAvailable || added === 0) break;

        // Respect Brave's burst limit between paginated calls.
        if (page < maxPages - 1) await new Promise(r => setTimeout(r, 500));
      }

      return { query: effectiveQuery, totalResults: allItems.length, searchTime: 0, items: allItems };
    } catch (error) {
      return { error: error.message, items: [] };
    }
  }

  /**
   * Compile advanced search spec into Brave query
   */
  compileBraveQuery(spec = {}) {
    const {
      must = [],
      phrase = null,
      anyOf = [],
      noneOf = [],
      siteInclude = null,
      siteExclude = null,
      fileType = null,
      freshness = null,
    } = spec;

    const qParts = [];

    // Required terms
    for (const t of must) qParts.push(this._safeToken(t));

    // Exact phrase
    if (phrase) qParts.push(this._quote(phrase));

    // Exclude terms
    for (const t of noneOf) qParts.push(`-${this._safeToken(t)}`);

    // OR terms
    if (anyOf.length) {
      qParts.push(`(${anyOf.map(t => this._safeToken(t)).join(' OR ')})`);
    }

    if (siteInclude) {
      qParts.push(`site:${siteInclude}`);
    }
    if (siteExclude) {
      qParts.push(`-site:${siteExclude}`);
    }

    if (fileType) {
      qParts.push(`filetype:${fileType.replace(/^\./, '')}`);
    }

    const q = this._applyAllowedSites(qParts.join(' ').trim() || (phrase ? this._quote(phrase) : ''));
    const params = {};
    if (freshness) params.freshness = freshness;

    return { q, params };
  }

  /**
   * Run compiled advanced search
   */
  async braveAdvancedSearch({ compiled, count = 20 }) {
    if (!this.config.braveApiKey) {
      return { error: "Brave Search API key required.", items: [] };
    }
    if (!compiled?.q) {
      return { error: "Missing compiled query.", items: [] };
    }

    const endpoint = "https://api.search.brave.com/res/v1/web/search";
    const params = new URLSearchParams({
      q: compiled.q,
      count: String(Math.min(20, Math.max(1, count))),
    });

    for (const [k, v] of Object.entries(compiled.params || {})) {
      params.set(k, String(v));
    }
    if (this.pastQueries.has(compiled.q)) {
      return { error: `Duplicate query: "${compiled.q}" was already searched this session. Use a different query.`, items: [], duplicate: true };
    }

    try {
      const data = await this._fetchBrave(endpoint, params);
      this.pastQueries.add(compiled.q);
      return this._normalizeBraveResponse(data, compiled.q);
    } catch (error) {
      return { error: error.message, items: [] };
    }
  }

  async _fetchBrave(endpoint, params) {
    // Route through the Brave Search CORS worker (cloudflare-worker/worker.js).
    // Normalize to just the origin so stale stored values with /proxy?url= suffixes
    // don't corrupt the path.
    const rawBase = (this.config.braveSearchEndpoint || '').trim();
    if (!rawBase) {
      throw new Error('Brave Search worker URL is not configured. Add it in Settings.');
    }

    let workerOrigin;
    try {
      const withProtocol = rawBase.includes('://') ? rawBase : `https://${rawBase}`;
      workerOrigin = new URL(withProtocol).origin;
    } catch {
      throw new Error(`Invalid Brave Search worker URL: "${rawBase}"`);
    }

    const braveUrl = new URL(endpoint);
    const workerUrl = `${workerOrigin}${braveUrl.pathname}?${params.toString()}`;
    console.log('[Brave] fetching via worker:', workerUrl);

    const res = await fetch(workerUrl, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': this.config.braveApiKey,
      }
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Brave Search via Worker failed (HTTP ${res.status}): ${text}`);
    }

    return await res.json();
  }

  /**
   * Multi-site search with result merging
   */
  async braveMultiSiteSearch({ spec, sites = [], perSite = 20 }) {
    const results = [];
    const seen = new Set();

    if (!sites.length) {
      const compiled = this.compileBraveQuery(spec);
      return await this.braveAdvancedSearch({ compiled, count: perSite });
    }

    for (let i = 0; i < sites.length; i++) {
      // Respect Brave's 1 req/sec burst limit between per-site calls
      if (i > 0) await new Promise(r => setTimeout(r, 1100));

      const compiled = this.compileBraveQuery({ ...spec, siteInclude: sites[i] });
      const r = await this.braveAdvancedSearch({ compiled, count: perSite });

      for (const item of r.items || []) {
        if (!seen.has(item.link)) {
          seen.add(item.link);
          results.push(item);
        }
      }
    }

    return {
      query: spec?.phrase || null,
      totalResults: results.length,
      items: results
    };
  }

  // ============================================================
  // URL FETCHING & TEXT EXTRACTION
  // ============================================================

  /**
   * Fetch URL with CORS proxy fallback
   */
  async fetchUrl({ url, max_chars = null }) {
    if (this.readUrls.has(url)) {
      return { url, skipped: true, reason: "Already read" };
    }
    this.readUrls.add(url);

    const maxChars = max_chars || this.config.maxFetchChars;

    try {
      const { text: raw, isPdf } = await this._fetchHtmlWithFallback(url);
      // PDF text is already plain — skip the HTML-stripping step.
      const text = isPdf ? raw : this.extractReadableText(raw);

      const result = {
        url,
        content: text.slice(0, maxChars),
        truncated: text.length > maxChars,
        charCount: Math.min(text.length, maxChars),
        fullLength: text.length,
      };

      // Cache in IndexedDB
      await this._cacheDocument(url, text);

      return result;
    } catch (error) {
      return { url, error: `Failed: ${error.message}`, content: '' };
    }
  }

  /**
   * Extract readable text from HTML using DOM parsing
   */
  extractReadableText(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Remove unwanted elements
    const unwanted = doc.querySelectorAll(
      'script, style, nav, header, footer, aside, iframe, noscript, svg, form, ' +
      '[role="navigation"], [role="banner"], [role="contentinfo"], .ad, .advertisement, ' +
      '.sidebar, .nav, .menu, .footer, .header, .comments, #comments'
    );
    unwanted.forEach(el => el.remove());

    // Try to find main content
    const mainSelectors = [
      'article',
      'main',
      '[role="main"]',
      '.post-content',
      '.article-content',
      '.entry-content',
      '.content',
      '.post',
      '#content',
      '#main',
    ];

    let targetEl = null;
    for (const selector of mainSelectors) {
      targetEl = doc.querySelector(selector);
      if (targetEl) break;
    }
    targetEl = targetEl || doc.body;

    // Extract text with some structure preservation
    let text = this._extractTextWithStructure(targetEl);

    // Clean up whitespace
    text = text
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();

    return text;
  }

  _extractTextWithStructure(el) {
    const blocks = [];

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        if (text) blocks.push(text);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();

        // Block-level elements get line breaks
        if (['p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'br'].includes(tag)) {
          if (blocks.length && blocks[blocks.length - 1] !== '\n') {
            blocks.push('\n');
          }
        }

        // Headers get extra emphasis
        if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
          blocks.push('\n');
        }

        for (const child of node.childNodes) {
          walk(child);
        }

        if (['p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
          blocks.push('\n');
        }
      }
    };

    walk(el);
    return blocks.join(' ');
  }

  // ============================================================
  // TEXT PROCESSING
  // ============================================================

  /**
   * Chunk text into smaller segments for processing
   */
  chunkText({ text, chunk_size = 1000, overlap = 100 }) {
    const chunks = [];
    let start = 0;

    while (start < text.length) {
      let end = start + chunk_size;

      // Try to break at sentence boundary
      if (end < text.length) {
        const breakPoints = ['. ', '! ', '? ', '\n\n', '\n'];
        for (const bp of breakPoints) {
          const idx = text.lastIndexOf(bp, end);
          if (idx > start + chunk_size / 2) {
            end = idx + bp.length;
            break;
          }
        }
      }

      chunks.push({
        index: chunks.length,
        text: text.slice(start, end).trim(),
        start,
        end: Math.min(end, text.length),
      });

      start = end - overlap;
    }

    return { chunks, totalChunks: chunks.length };
  }

  /**
   * Extract key sentences using semantic similarity
   */
  async extractKeySentences({ text, max_sentences = 5 }) {
    // Split into sentences
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 20 && s.length < 500);

    if (sentences.length <= max_sentences) {
      return { sentences, count: sentences.length };
    }

    if (!this.embedder) {
      // Fallback to heuristic if no model
      return this._extractKeySentencesHeuristic({ sentences, max_sentences });
    }

    try {
      // Semantic extraction: Compare sentences to the full text (document embedding)
      const docEmbedding = await this.embedText(text.slice(0, 1000)); // Embed start of doc as proxy for theme

      const scored = [];
      for (const s of sentences) {
        const emb = await this.embedText(s);
        const score = this._cosineSimilarity(docEmbedding, emb);
        scored.push({ text: s, score });
      }

      scored.sort((a, b) => b.score - a.score);

      return {
        sentences: scored.slice(0, max_sentences).map(s => s.text),
        count: max_sentences
      };
    } catch (e) {
      console.error('Semantic extraction failed:', e);
      return this._extractKeySentencesHeuristic({ sentences, max_sentences });
    }
  }

  _extractKeySentencesHeuristic({ sentences, max_sentences }) {
    const scored = sentences.map((s, i) => ({
      text: s,
      score: this._scoreSentence(s, i, sentences.length),
    }));

    scored.sort((a, b) => b.score - a.score);

    return {
      sentences: scored.slice(0, max_sentences).map(s => s.text),
      count: scored.length
    };
  }

  _scoreSentence(sentence, position, total) {
    let score = 0;

    // Position bias (first and last are usually important)
    if (position < 3) score += (3 - position) * 0.2;
    if (position > total - 3) score += (3 - (total - position)) * 0.1;

    // Length (medium-length sentences often have more content)
    const idealLen = 150;
    score += 1 - Math.abs(sentence.length - idealLen) / idealLen;

    // Keyword presence
    const keywords = ['important', 'significant', 'key', 'major', 'critical', 'result', 'conclusion', 'finding'];
    for (const kw of keywords) {
      if (sentence.toLowerCase().includes(kw)) score += 0.3;
    }

    return score;
  }

  // ============================================================
  // NOTES & REPORTS
  // ============================================================

  /**
   * Save a research note
   */
  saveNote({ title, content, source_url = null, tags = [], role = 'context', relevance = '', angleTag = null, source_title = '' }) {
    const note = {
      id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      content,
      source_url,
      source_title,
      tags,
      role,
      relevance,
      angleTag,
      timestamp: new Date().toISOString(),
    };

    this.notes.push(note);

    // Persist to IndexedDB
    if (this.db) {
      const tx = this.db.transaction('notes', 'readwrite');
      tx.objectStore('notes').add(note);
    }

    return { success: true, note_id: note.id, note };
  }

  noteQualityIssue(note) {
    if (!note || String(note).trim().length < 30) {
      return 'note is too short';
    }

    if (this._isCodeLikeNote(note)) {
      return 'note looks like code or CSS';
    }

    const lower = String(note).toLowerCase();
    const blockedMarkers = [
      'enable javascript',
      'unusual traffic',
      'verify you are human',
      'checking your browser',
      'access denied',
      'captcha',
      'cookie settings',
      'please enable cookies',
    ];
    if (blockedMarkers.some(marker => lower.includes(marker))) {
      return 'note looks like a blocked-page message';
    }

    const listingMarkers = [
      'cited by ',
      'related articles',
      'all versions',
      'google scholar',
      ' - ieeexplore.ieee.org',
      ' - sciencedirect.com',
      ' - link.springer.com',
    ];
    if (listingMarkers.some(marker => lower.includes(marker)) && !this._isSentenceLikeNote(note)) {
      return 'note looks like a search-result listing';
    }

    return null;
  }

  _isSentenceLikeNote(note) {
    const words = String(note).split(/\s+/).filter(Boolean);
    const hasSentenceEnd = words.some(word => /[.!?]$/.test(word));
    return words.length >= 8 && hasSentenceEnd;
  }

  _isCodeLikeNote(note) {
    const lower = String(note).toLowerCase();
    const markers = [
      'const ',
      'let ',
      'var ',
      'document.queryselector',
      'addeventlistener',
      'classlist.',
      'function ',
      '=>',
      '{display:',
      '{font-size:',
      '{margin:',
      '{padding:',
      'text-decoration:',
      'background:',
    ];
    if (markers.some(marker => lower.includes(marker))) return true;

    const punctuation = [...String(note)].filter(c => '{};=<>'.includes(c)).length;
    return punctuation >= 10 && punctuation * 5 > String(note).length;
  }

  /**
   * Search notes by keyword
   */
  searchNotes({ query, limit = 10 }) {
    const queryLower = query.toLowerCase();

    const matches = this.notes
      .filter(n =>
        n.title.toLowerCase().includes(queryLower) ||
        n.content.toLowerCase().includes(queryLower) ||
        n.tags.some(t => t.toLowerCase().includes(queryLower))
      )
      .slice(0, limit);

    return { results: matches, count: matches.length };
  }

  /**
   * Write final research report
   */
  writeReport({ title, sections, conclusion, include_sources = true }) {
    let markdown = `# ${title}\n\n`;
    markdown += `*Generated: ${new Date().toLocaleString()}*\n\n`;

    // Add sections
    for (const section of sections) {
      markdown += `## ${section.heading}\n\n`;
      markdown += `${section.content}\n\n`;
    }

    // Conclusion
    markdown += `## Conclusion\n\n${conclusion}\n\n`;

    // Sources
    if (include_sources && this.sources.length > 0) {
      markdown += `## Sources\n\n`;
      this.sources.forEach((source, i) => {
        markdown += `${i + 1}. [${source.title}](${source.link})\n`;
      });
      markdown += '\n';
    }

    // Notes used
    if (this.notes.length > 0) {
      markdown += `## Research Notes\n\n`;
      this.notes.forEach((note, i) => {
        markdown += `### ${note.title}\n`;
        markdown += `${note.content}\n\n`;
      });
    }

    return {
      success: true,
      report: markdown,
      isComplete: true,
      stats: {
        sections: sections.length,
        sources: this.sources.length,
        notes: this.notes.length,
      }
    };
  }

  saveReport({ question, report, kind = 'main', notes_count = 0, sources_count = 0 }) {
    const entry = {
      id: `report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      question,
      report,
      kind,
      notes_count,
      sources_count,
      timestamp: new Date().toISOString(),
    };

    if (this.db) {
      try {
        const tx = this.db.transaction('reports', 'readwrite');
        tx.objectStore('reports').put(entry);
      } catch (e) {
        console.warn('Report save failed:', e);
      }
    }

    return entry;
  }

  async getReports(limit = 20) {
    if (!this.db || !this.db.objectStoreNames.contains('reports')) return [];

    return new Promise((resolve) => {
      const tx = this.db.transaction('reports', 'readonly');
      const store = tx.objectStore('reports');
      const request = store.getAll();
      request.onerror = () => resolve([]);
      request.onsuccess = () => {
        const reports = (request.result || [])
          .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
          .slice(0, limit);
        resolve(reports);
      };
    });
  }

  // ============================================================
  // COLLECTION ITEMS — table rows produced by the collection lane
  // ============================================================

  /** Persist a single collection row to IndexedDB. */
  async saveCollectionItem(row) {
    if (!this.db) return { success: false };
    try {
      const tx = this.db.transaction('collection_items', 'readwrite');
      tx.objectStore('collection_items').put(row);
      return { success: true, id: row.id };
    } catch (e) {
      console.warn('saveCollectionItem failed:', e);
      return { success: false, error: e.message };
    }
  }

  /** Return collection rows, most recent first. Optionally filtered by target. */
  async getCollectionItems({ target = null, limit = 500 } = {}) {
    if (!this.db || !this.db.objectStoreNames.contains('collection_items')) return [];
    return new Promise((resolve) => {
      const tx = this.db.transaction('collection_items', 'readonly');
      const req = tx.objectStore('collection_items').getAll();
      req.onerror = () => resolve([]);
      req.onsuccess = () => {
        let rows = req.result || [];
        if (target) rows = rows.filter(r => r.target === target);
        rows.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
        resolve(rows.slice(0, limit));
      };
    });
  }

  /** Delete all rows for a given target (used when a fresh run starts). */
  async clearCollectionItems({ target = null } = {}) {
    if (!this.db || !this.db.objectStoreNames.contains('collection_items')) return;
    return new Promise((resolve) => {
      const tx = this.db.transaction('collection_items', 'readwrite');
      const store = tx.objectStore('collection_items');
      if (!target) { store.clear(); tx.oncomplete = () => resolve(); return; }
      const req = store.openCursor();
      req.onerror = () => resolve();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) { resolve(); return; }
        if (cursor.value.target === target) cursor.delete();
        cursor.continue();
      };
    });
  }

  // ============================================================
  // VECTOR STORAGE
  // ============================================================

  /**
   * Store text with embedding
   */
  async storeVector({ id, text, metadata = {} }) {
    const vector = await this.embedText(text);

    this.vectorStore.set(id, {
      vector,
      text,
      metadata,
      timestamp: Date.now(),
    });

    return { success: true, id };
  }

  /**
   * Search vectors by similarity
   */
  async searchVectors({ query, limit = 5 }) {
    const queryVec = await this.embedText(query);

    const results = [];
    for (const [id, entry] of this.vectorStore) {
      const similarity = this._cosineSimilarity(queryVec, entry.vector);
      results.push({
        id,
        text: entry.text.slice(0, 200),
        similarity,
        metadata: entry.metadata,
      });
    }

    results.sort((a, b) => b.similarity - a.similarity);

    return { results: results.slice(0, limit) };
  }

  async embedText(text) {
    if (!this.embedder) {
      return this._simpleEmbed(text);
    }

    // Use Transformers.js pipeline
    const output = await this.embedder(text, { pooling: 'mean', normalize: true });
    return output.data;
  }

  _simpleEmbed(text) {
    // Fallback: Very simple word frequency vector (use real embeddings in production!)
    const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 2);
    const freq = new Map();

    for (const word of words) {
      freq.set(word, (freq.get(word) || 0) + 1);
    }

    // Convert to fixed-size vector using hashing
    const vec = new Float32Array(this.config.vectorDimensions);
    for (const [word, count] of freq) {
      const hash = this._hashString(word) % this.config.vectorDimensions;
      vec[hash] += count;
    }

    // Normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    }

    return vec;
  }

  _cosineSimilarity(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
  }

  _hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  // ============================================================
  // HELPER METHODS
  // ============================================================

  async _fetchWithFallback(url, options = {}) {
    try {
      const res = await fetch(url, { ...options });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      // Try JSONP for Google APIs
      return await this._jsonp(url);
    }
  }

  async _fetchHtmlWithFallback(url) {
    const isPdfUrl = /\.pdf(\?[^#]*)?$/i.test(url);

    // PDFs always need the proxy (direct fetch is blocked by CORS on every govt site).
    // For HTML we try direct first, fall back to proxy, then Jina reader.
    if (!isPdfUrl) {
      try {
        const res = await fetch(url, {
          headers: { 'Accept': 'text/html,application/xhtml+xml' }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { text: await res.text(), isPdf: false };
      } catch (_corsErr) {
        // fall through to proxy
      }
    }

    // Tier 2: CORS proxy
    if (this.config.corsProxyUrl) {
      try {
        const proxyUrl = this.config.corsProxyUrl + encodeURIComponent(url);
        const res = await fetch(proxyUrl);
        if (res.ok) {
          const ct = (res.headers.get('Content-Type') || '').toLowerCase();
          if (ct.includes('application/pdf') || isPdfUrl) {
            const buf = await res.arrayBuffer();
            const text = await this._extractPdfText(buf);
            return { text, isPdf: true };
          }
          return { text: await res.text(), isPdf: false };
        }
      } catch (_proxyErr) {
        // fall through to Jina
      }
    }

    // Tier 3: Jina Reader — free JS-rendering proxy, useful when direct fetch and
    // the Cloudflare worker both fail (e.g. paywalled sites, heavy JS pages).
    if (!isPdfUrl) {
      const jinaUrl = `https://r.jina.ai/${url}`;
      const res = await fetch(jinaUrl, {
        headers: { 'Accept': 'text/plain,text/html' }
      });
      if (!res.ok) throw new Error(`Jina ${res.status}`);
      return { text: await res.text(), isPdf: false };
    }

    throw new Error('All fetch tiers failed for this URL.');
  }

  // Extract plain text from a PDF ArrayBuffer using pdfjs-dist (loaded lazily from CDN).
  async _extractPdfText(arrayBuffer) {
    if (!this._pdfjsLib) {
      const lib = await import(
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.mjs'
      );
      // Point the worker at the matching CDN build so pdfjs can offload parsing.
      lib.GlobalWorkerOptions.workerSrc =
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
      this._pdfjsLib = lib;
    }

    const pdfjs = this._pdfjsLib;
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    const pageTexts = [];
    const limit = Math.min(pdf.numPages, 120); // cap at 120 pages
    for (let i = 1; i <= limit; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const line = content.items.map(item => item.str).join(' ').trim();
      if (line) pageTexts.push(line);
    }
    return pageTexts.join('\n\n');
  }

  _jsonp(url, callbackParam = 'callback', timeout = 15000) {
    return new Promise((resolve, reject) => {
      const cbName = `__jsonp_${Math.random().toString(36).slice(2)}`;
      const u = new URL(url);
      u.searchParams.set(callbackParam, cbName);

      const script = document.createElement('script');
      script.src = u.toString();

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('JSONP timeout'));
      }, timeout);

      const cleanup = () => {
        clearTimeout(timer);
        delete window[cbName];
        script.remove();
      };

      window[cbName] = (data) => {
        cleanup();
        resolve(data);
      };

      script.onerror = () => {
        cleanup();
        reject(new Error('JSONP error'));
      };

      document.head.appendChild(script);
    });
  }

  _normalizeBraveResponse(data, query) {
    const results = (data?.web?.results || []).filter(it => this._isAllowedSearchResult(it.url));
    const items = results.map(it => ({
      title: it.title,
      link: it.url,
      snippet: it.description,
      displayLink: it.meta_url?.hostname || '',
      formattedUrl: it.url,
    }));

    // Track sources
    items.forEach(item => {
      if (!this.sources.find(s => s.link === item.link)) {
        this.sources.push({ ...item, foundAt: new Date().toISOString() });
      }
    });

    return {
      query: data?.query?.original || query,
      totalResults: items.length, // Brave doesn't return total exact count usually
      searchTime: 0,
      items,
    };
  }

  async _cacheDocument(url, text) {
    if (!this.db) return;

    try {
      const tx = this.db.transaction('documents', 'readwrite');
      const store = tx.objectStore('documents');

      await store.put({
        url,
        text: text.slice(0, 50000), // Limit storage
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      console.warn('Cache write failed:', e);
    }
  }

  _quote(s) {
    return `"${String(s).replace(/"/g, '\\"')}"`;
  }

  _safeToken(s) {
    return String(s).trim().replace(/\s+/g, ' ');
  }

  _safeOperatorValue(s) {
    const v = String(s).trim();
    return /\s/.test(v) ? this._quote(v) : v.replace(/"/g, '\\"');
  }

  _getAllowedSites() {
    return this._normalizeAllowedSites(this.config.allowedSites);
  }

  _normalizeAllowedSites(value) {
    const rawSites = Array.isArray(value)
      ? value
      : String(value || '').split(/[\n,]+/);

    const seen = new Set();
    const sites = [];

    for (const raw of rawSites) {
      let site = String(raw || '').trim().toLowerCase();
      if (!site) continue;
      site = site.replace(/^site:/i, '').trim();

      try {
        const url = new URL(site.includes('://') ? site : `https://${site}`);
        site = url.hostname;
      } catch {
        site = site.replace(/^https?:\/\//, '').split('/')[0];
      }

      site = site.replace(/^www\./, '').replace(/[^\w.-]/g, '');
      if (!site || seen.has(site)) continue;
      seen.add(site);
      sites.push(site);
    }

    return sites;
  }

  _applyAllowedSites(query) {
    const sites = this._getAllowedSites();
    const cleanQuery = String(query || '').trim();
    if (!sites.length || !cleanQuery) return cleanQuery;

    const scopedQuery = this._stripSearchQuotes(this._stripSiteOperators(cleanQuery)) || this._stripSearchQuotes(cleanQuery);
    const siteGroup = sites.map(site => `site:${site}`).join(' OR ');
    return `${scopedQuery} ${siteGroup}`;
  }

  _stripSiteOperators(query) {
    return String(query || '')
      .replace(/(^|\s)-?site:[^\s)]+/gi, ' ')
      .replace(/\(\s*(?:OR\s*)+\)/gi, ' ')
      .replace(/\(\s*\)/g, ' ')
      .replace(/\s+OR\s+(?=\))/gi, ' ')
      .replace(/\(\s+OR\s+/gi, '(')
      .replace(/^(?:OR\s+)+/i, '')
      .replace(/(?:\s+OR)+$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _stripSearchQuotes(query) {
    return String(query || '')
      .replace(/["'“”‘’]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _isAllowedSearchResult(url) {
    const sites = this._getAllowedSites();
    if (!sites.length) return true;

    try {
      const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      return sites.some(site => hostname === site || hostname.endsWith(`.${site}`));
    } catch {
      return false;
    }
  }

  // ============================================================
  // TOOL SCHEMA EXPORT
  // ============================================================

  getToolSchema() {
    return [
      {
        type: "function",
        function: {
          name: "brave_web_search",
          description: "Search the web using Brave Search API.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
              count: { type: "integer", description: "Number of results (1-20)" },
              freshness: { type: "string", description: 'Freshness like "pd" (past day), "pw" (past week), "pm", "py"' }
            },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "brave_advanced_search",
          description: "Run an advanced search with filters for site, filetype, etc.",
          parameters: {
            type: "object",
            properties: {
              must: { type: "array", items: { type: "string" }, description: "Required terms" },
              phrase: { type: "string", description: "Exact phrase to match" },
              anyOf: { type: "array", items: { type: "string" }, description: "Any of these terms" },
              noneOf: { type: "array", items: { type: "string" }, description: "Exclude these terms" },
              siteInclude: { type: "string", description: "Limit to this domain" },
              fileType: { type: "string", description: "File type (pdf, doc, etc.)" },
              freshness: { type: "string", description: "Freshness like pd, pw, pm, py" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "fetch_url",
          description: "Fetch and extract readable text from a webpage URL.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "URL to fetch" },
              max_chars: { type: "integer", description: "Max characters to return" }
            },
            required: ["url"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "chunk_text",
          description: "Split text into smaller chunks for processing.",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string", description: "Text to chunk" },
              chunk_size: { type: "integer", description: "Size of each chunk" },
              overlap: { type: "integer", description: "Overlap between chunks" }
            },
            required: ["text"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "extract_key_sentences",
          description: "Extract the most important sentences from text.",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string", description: "Source text" },
              max_sentences: { type: "integer", description: "Max sentences to extract" }
            },
            required: ["text"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "save_note",
          description: "Save an important finding to research notes.",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", description: "Note title" },
              content: { type: "string", description: "Note content" },
              source_url: { type: "string", description: "Source URL" },
              tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" }
            },
            required: ["title", "content"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "search_notes",
          description: "Search through saved research notes.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
              limit: { type: "integer", description: "Max results" }
            },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "store_vector",
          description: "Store text in vector memory for semantic search.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique ID for the vector" },
              text: { type: "string", description: "Text to store" },
              metadata: { type: "object", description: "Additional metadata" }
            },
            required: ["id", "text"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "search_vectors",
          description: "Search stored vectors by semantic similarity.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
              limit: { type: "integer", description: "Max results" }
            },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "write_report",
          description: "Write the final research report with all findings.",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", description: "Report title" },
              sections: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    heading: { type: "string" },
                    content: { type: "string" }
                  }
                },
                description: "Report sections"
              },
              conclusion: { type: "string", description: "Final conclusion" },
              include_sources: { type: "boolean", description: "Include source list" }
            },
            required: ["title", "sections", "conclusion"]
          }
        }
      }
    ];
  }

  /**
   * Execute a tool by name
   */
  async executeTool(toolName, args) {
    const toolMap = {
      'brave_web_search': (a) => this.braveWebSearch(a),
      'brave_advanced_search': async (a) => {
        const compiled = this.compileBraveQuery(a);
        return await this.braveAdvancedSearch({ compiled });
      },
      'brave_multi_site_search': (a) => this.braveMultiSiteSearch(a),
      'fetch_url': (a) => this.fetchUrl(a),
      'chunk_text': (a) => this.chunkText(a),
      'extract_key_sentences': (a) => this.extractKeySentences(a),
      'save_note': (a) => this.saveNote(a),
      'search_notes': (a) => this.searchNotes(a),
      'store_vector': (a) => this.storeVector(a),
      'search_vectors': (a) => this.searchVectors(a),
      'write_report': (a) => this.writeReport(a),
    };

    const fn = toolMap[toolName];
    if (!fn) {
      return { error: `Unknown tool: ${toolName}` };
    }

    try {
      return await fn(args);
    } catch (error) {
      return { error: error.message };
    }
  }

  // State accessors
  getSources() { return this.sources; }
  getNotes() { return this.notes; }
  getPastQueries() { return Array.from(this.pastQueries); }
  clearState() {
    this.sources = [];
    this.notes = [];
    this.readUrls.clear();
    this.pastQueries.clear();
    this.vectorStore.clear();
  }
}

export default ToolRegistry;

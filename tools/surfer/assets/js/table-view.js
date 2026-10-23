/**
 * Node table view (Session 4).
 *
 * A sortable, filterable, virtualized table over the *full* current graph — the
 * accessible / screen-reader-friendly counterpart to the canvas, and a genuinely
 * useful "ranked list" tool. Pure row logic lives in table-model.js; this file is
 * the DOM + virtualization + keyboard layer.
 */
import { TABLE_COLUMNS, buildTableRows, filterTableRows, sortTableRows } from './table-model.js';
import { riskColor, riskTextColor } from './risk-color.js';
import { escapeHtml } from './utils.js';

const ROW_HEIGHT = 34;   // px, fixed — keeps virtualization math trivial
const BUFFER = 8;        // extra rows above/below the viewport

export class TableView {
  constructor(container, { onRowClick } = {}) {
    this.container = container;
    this.onRowClick = onRowClick;
    this.allRows = [];
    this.viewRows = [];
    this.nodeById = new Map();
    this.sortKey = 'score';
    this.sortDir = 'desc';
    this.filterText = '';
    this.flaggedOnly = false;
    this.activeIndex = -1;
    this._built = false;
  }

  isVisible() {
    return !this.container.hidden;
  }

  focus() {
    this.scrollEl?.focus();
  }

  build() {
    if (this._built) return;
    this.container.innerHTML = '';
    this.container.setAttribute('role', 'table');
    this.container.setAttribute('aria-label', 'Network nodes table');

    // Toolbar: filter + flagged-only + live row count
    const toolbar = document.createElement('div');
    toolbar.className = 'table-toolbar';

    this.filterInput = document.createElement('input');
    this.filterInput.type = 'search';
    this.filterInput.className = 'table-filter';
    this.filterInput.placeholder = 'Filter by account, type, or community…';
    this.filterInput.setAttribute('aria-label', 'Filter table rows');
    this.filterInput.addEventListener('input', () => {
      this.filterText = this.filterInput.value;
      this.applyFilterSort();
    });

    const flaggedLabel = document.createElement('label');
    flaggedLabel.className = 'table-flagged-toggle';
    this.flaggedCheckbox = document.createElement('input');
    this.flaggedCheckbox.type = 'checkbox';
    this.flaggedCheckbox.addEventListener('change', () => {
      this.flaggedOnly = this.flaggedCheckbox.checked;
      this.applyFilterSort();
    });
    flaggedLabel.append(this.flaggedCheckbox, document.createTextNode(' Flagged only'));

    this.countEl = document.createElement('span');
    this.countEl.className = 'table-count';
    this.countEl.setAttribute('aria-live', 'polite');

    toolbar.append(this.filterInput, flaggedLabel, this.countEl);

    // Header (sortable column buttons)
    this.headerEl = document.createElement('div');
    this.headerEl.className = 'table-header';
    this.headerEl.setAttribute('role', 'row');
    TABLE_COLUMNS.forEach(col => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'table-col ' + (col.type === 'number' ? 'col-num' : 'col-text');
      btn.dataset.key = col.key;
      btn.setAttribute('role', 'columnheader');
      btn.setAttribute('aria-sort', 'none');
      btn.innerHTML = `<span>${escapeHtml(col.label)}</span><span class="sort-caret" aria-hidden="true"></span>`;
      btn.addEventListener('click', () => this.toggleSort(col.key));
      this.headerEl.appendChild(btn);
    });

    // Virtualized scroll body
    this.scrollEl = document.createElement('div');
    this.scrollEl.className = 'table-scroll';
    this.scrollEl.setAttribute('role', 'rowgroup');
    this.scrollEl.tabIndex = 0;
    this.scrollEl.setAttribute('aria-label', 'Table rows. Use arrow keys to move, Enter to open a node.');
    this.spacerEl = document.createElement('div');
    this.spacerEl.className = 'table-spacer';
    this.rowsEl = document.createElement('div');
    this.rowsEl.className = 'table-rows';
    this.scrollEl.append(this.spacerEl, this.rowsEl);
    this.scrollEl.addEventListener('scroll', () => this.renderWindow());
    this.scrollEl.addEventListener('keydown', e => this.onKeyDown(e));
    this.rowsEl.addEventListener('click', e => {
      const rowEl = e.target.closest('.table-row');
      if (!rowEl) return;
      this.activate(Number(rowEl.dataset.index), true);
    });

    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'table-empty';
    this.emptyEl.textContent = 'No nodes to show. Load data to populate the table.';

    this.container.append(toolbar, this.headerEl, this.scrollEl, this.emptyEl);
    this._built = true;
  }

  setNodes(nodes, communityNameFor) {
    this.build();
    const list = Array.isArray(nodes) ? nodes : [];
    this.nodeById = new Map(list.map(n => [n.id, n]));
    this.allRows = buildTableRows(list, communityNameFor);
    this.activeIndex = -1;
    this.applyFilterSort();
  }

  applyFilterSort() {
    const filtered = filterTableRows(this.allRows, { text: this.filterText, flaggedOnly: this.flaggedOnly });
    this.viewRows = sortTableRows(filtered, this.sortKey, this.sortDir);

    const n = this.viewRows.length;
    this.spacerEl.style.height = (n * ROW_HEIGHT) + 'px';
    this.countEl.textContent = `${n.toLocaleString()} of ${this.allRows.length.toLocaleString()} node${this.allRows.length === 1 ? '' : 's'}`;
    this.emptyEl.style.display = this.allRows.length === 0 ? 'block' : 'none';

    if (this.activeIndex >= n) this.activeIndex = n - 1;
    this.updateHeaderSortState();
    this.scrollEl.scrollTop = 0;
    this.renderWindow();
  }

  toggleSort(key) {
    if (this.sortKey === key) {
      this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortKey = key;
      const col = TABLE_COLUMNS.find(c => c.key === key);
      this.sortDir = col && col.type === 'number' ? 'desc' : 'asc';
    }
    this.applyFilterSort();
  }

  updateHeaderSortState() {
    this.headerEl.querySelectorAll('.table-col').forEach(btn => {
      const active = btn.dataset.key === this.sortKey;
      btn.classList.toggle('sorted', active);
      btn.dataset.dir = active ? this.sortDir : '';
      btn.setAttribute('aria-sort', active ? (this.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
  }

  renderWindow() {
    const n = this.viewRows.length;
    const scrollTop = this.scrollEl.scrollTop;
    const viewport = this.scrollEl.clientHeight || 400;
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER);
    const end = Math.min(n, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + BUFFER);

    let html = '';
    for (let i = start; i < end; i++) html += this.rowHtml(this.viewRows[i], i);
    this.rowsEl.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
    this.rowsEl.innerHTML = html;
  }

  rowHtml(row, i) {
    const num = v => (v == null ? '<span class="muted">—</span>' : v.toLocaleString());
    const activeCls = i === this.activeIndex ? ' active' : '';
    const flagCls = row.flagged ? ' flagged' : '';
    const score = row.flagged
      ? `<span class="score-pill" style="background:${riskColor(row.score)};color:${riskTextColor(row.score)}">${Math.round(row.score)}</span>`
      : '<span class="muted">—</span>';
    const flagDot = row.flagged ? '<span class="flag-dot" title="Flagged" aria-label="flagged"></span>' : '';
    return `<div class="table-row${activeCls}${flagCls}" role="row" data-index="${i}" style="height:${ROW_HEIGHT}px">`
      + `<span class="cell col-text" role="cell">${flagDot}${escapeHtml(row.label)}</span>`
      + `<span class="cell col-text" role="cell">${escapeHtml(row.type)}</span>`
      + `<span class="cell col-num" role="cell">${num(row.degree)}</span>`
      + `<span class="cell col-text" role="cell">${escapeHtml(row.community)}</span>`
      + `<span class="cell col-num" role="cell">${num(row.followers)}</span>`
      + `<span class="cell col-num" role="cell">${num(row.posts)}</span>`
      + `<span class="cell col-num" role="cell">${score}</span>`
      + `<span class="cell col-num" role="cell">${num(row.indicators)}</span>`
      + `</div>`;
  }

  activate(index, fireClick) {
    if (index < 0 || index >= this.viewRows.length) return;
    this.activeIndex = index;
    this.ensureVisible(index);
    this.renderWindow();
    if (fireClick && this.onRowClick) {
      const node = this.nodeById.get(this.viewRows[index].id);
      if (node) this.onRowClick(node);
    }
  }

  ensureVisible(index) {
    const top = index * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    const viewTop = this.scrollEl.scrollTop;
    const viewBottom = viewTop + (this.scrollEl.clientHeight || 400);
    if (top < viewTop) this.scrollEl.scrollTop = top;
    else if (bottom > viewBottom) this.scrollEl.scrollTop = bottom - (this.scrollEl.clientHeight || 400);
  }

  onKeyDown(e) {
    const n = this.viewRows.length;
    if (!n) return;
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': this.activate(Math.min(n - 1, (this.activeIndex < 0 ? -1 : this.activeIndex) + 1)); break;
      case 'ArrowUp': this.activate(Math.max(0, (this.activeIndex < 0 ? n : this.activeIndex) - 1)); break;
      case 'Home': this.activate(0); break;
      case 'End': this.activate(n - 1); break;
      case 'PageDown': this.activate(Math.min(n - 1, (this.activeIndex < 0 ? 0 : this.activeIndex) + 10)); break;
      case 'PageUp': this.activate(Math.max(0, (this.activeIndex < 0 ? 0 : this.activeIndex) - 10)); break;
      case 'Enter':
      case ' ':
        if (this.activeIndex >= 0) this.activate(this.activeIndex, true);
        break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }
}

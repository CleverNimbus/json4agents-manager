/**
 * Sortable grid used by both tabs.
 *
 * Columns are plain objects so each tab describes its own layout:
 *   { key, label, align?, className?, value?(row), text?(row), title?(row), sortable? }
 *
 * `value` feeds sorting (full hash), `text` feeds the cell (short hash) and
 * `title` feeds the tooltip (full hash).
 */
function compare(a, b) {
  if (a === b) return 0;
  if (a === undefined || a === null || a === '') return 1;
  if (b === undefined || b === null || b === '') return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
}

export default {
  name: 'DataTable',
  props: {
    columns: { type: Array, required: true },
    rows: { type: Array, default: () => [] },
    rowKey: { type: String, default: '' },
    defaultSort: { type: String, default: '' },
    emptyText: { type: String, default: 'Nothing to show' },
    clickable: { type: Boolean, default: false },
    maxRows: { type: Number, default: 2000 },
  },
  emits: ['row-click'],
  data() {
    return { sortKey: this.defaultSort, sortDir: 'asc', showAll: false };
  },
  computed: {
    sortedRows() {
      const column = this.columns.find((col) => col.key === this.sortKey);
      if (!column) return this.rows;
      const direction = this.sortDir === 'asc' ? 1 : -1;
      return [...this.rows].sort((a, b) => direction * compare(this.rawValue(a, column), this.rawValue(b, column)));
    },
    visibleRows() {
      return this.showAll ? this.sortedRows : this.sortedRows.slice(0, this.maxRows);
    },
  },
  methods: {
    rawValue(row, column) {
      return column.value ? column.value(row) : row[column.key];
    },
    displayText(row, column) {
      if (column.text) return column.text(row);
      const value = this.rawValue(row, column);
      return value === undefined || value === null ? '' : String(value);
    },
    titleFor(row, column) {
      return column.title ? column.title(row) : this.displayText(row, column);
    },
    headerClass(column) {
      return {
        sortable: column.sortable !== false,
        [`align-${column.align ?? 'left'}`]: true,
      };
    },
    sortBy(column) {
      if (column.sortable === false) return;
      if (this.sortKey === column.key) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
      else {
        this.sortKey = column.key;
        this.sortDir = 'asc';
      }
    },
    keyOf(row, index) {
      return this.rowKey ? row[this.rowKey] : index;
    },
  },
  template: `
    <div class="table-wrap">
      <table class="grid">
        <thead>
          <tr>
            <th v-for="col in columns" :key="col.key" :class="headerClass(col)" @click="sortBy(col)">
              <span>{{ col.label }}</span>
              <span class="sort-mark" v-if="sortKey === col.key">{{ sortDir === 'asc' ? '▲' : '▼' }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, index) in visibleRows"
            :key="keyOf(row, index)"
            :class="{ clickable: clickable }"
            @click="clickable && $emit('row-click', row, index)"
          >
            <td v-for="col in columns" :key="col.key" :class="col.className" :title="titleFor(row, col)">
              <slot :name="'cell-' + col.key" :row="row" :index="index">{{ displayText(row, col) }}</slot>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td class="empty" :colspan="columns.length">{{ emptyText }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="sortedRows.length > maxRows" class="table-foot">
        Showing {{ visibleRows.length }} of {{ sortedRows.length }} rows.
        <button type="button" class="link" @click="showAll = !showAll">
          {{ showAll ? 'Show fewer' : 'Show all' }}
        </button>
      </div>
    </div>
  `,
};
/**
 * Minimal frontmatter reader for docs/prd. Handles scalars and inline arrays, which is all
 * the PRD files use. Shared by lint-docs.mjs and lint-controls.mjs so that a PRD's
 * `controls:` field is read by the same parser that reads its `depends_on`.
 */
export function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return null;
  const out = {};
  for (const line of match[1].split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let raw = line.slice(idx + 1).trim();
    raw = raw.replace(/\s+#.*$/, '').trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const inner = raw.slice(1, -1).trim();
      out[key] = inner ? inner.split(',').map((s) => s.trim()) : [];
    } else if (raw === 'null' || raw === '') {
      out[key] = null;
    } else {
      out[key] = raw;
    }
  }
  return out;
}

/**
 * The PRD index rows in docs/prd/README.md, keyed by id. A row is either a linked id
 * (`[P1-A](P1-A-eval-harness.md)`) or a bare one (`P1-D`) for a PRD with no file yet.
 */
export function prdIndexRows(text) {
  const rows = new Map();
  for (const line of text.split('\n')) {
    const row = /^\|\s*(?:\[([^\]]+)\]\([^)]+\)|([A-Z]\d-[A-Z]))\s*\|(.+)\|\s*$/.exec(line);
    if (!row) continue;
    const id = row[1] ?? row[2];
    const cells = row[3].split('|').map((c) => c.trim());
    rows.set(id, { status: cells[cells.length - 1], size: cells[cells.length - 2] });
  }
  return rows;
}

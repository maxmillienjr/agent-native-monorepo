#!/usr/bin/env node
/**
 * "Specced vs shipped": a static site over docs/prd.
 *
 * Every PRD is written before its feature, and most shipped ones end with a section on what
 * shipped and where it diverged from the design. This script puts each PRD's Problem beside
 * that section, one page per PRD, and leads the index with the dependency graph drawn from
 * `depends_on` and `blocks`. Every number on the site is computed here from the files; none
 * is typed by hand.
 *
 * No dependencies: the frontmatter reader is the one lint-docs.mjs uses, and the Markdown
 * renderer below covers the subset docs/prd uses (headings, paragraphs, nested lists, task
 * items, fenced code, tables, blockquotes, inline code, emphasis, links). The output has no
 * external script, font, stylesheet, analytics or tracker, and no timestamp: two builds of
 * the same commit are byte-identical.
 *
 *   node scripts/prd-site.mjs [--out dist/prd-site]   build the site
 *   node scripts/prd-site.mjs --check                 build in memory and fail on problems
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { frontmatter } from './lib/frontmatter.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_URL = 'https://github.com/maxmillienjr/agent-native-monorepo';
const PRD_DIR = 'docs/prd';

/** The frontmatter fields the site reads. A PRD missing one fails --check. */
export const REQUIRED = ['id', 'title', 'tier', 'status', 'size', 'depends_on', 'blocks'];
const STATUS_ORDER = ['shipped', 'in-progress', 'accepted', 'draft', 'superseded'];
const STATUS_LABEL = {
  shipped: 'shipped',
  'in-progress': 'in progress',
  accepted: 'accepted',
  draft: 'draft',
  superseded: 'superseded',
};

/** Headings that record what the build did, in a PRD with no "where it diverged" heading. */
const AFTER_SHIP =
  /^(what shipped\b|what (the )?implementation (found|added)\b|post-ship correction\b)/i;

// --- Loading ---------------------------------------------------------------

/** The PRD files of a repo checkout, as `{ file, text }`. README and the template are not PRDs. */
export function readPrdFiles(repoRoot = root) {
  const dir = join(repoRoot, PRD_DIR);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md' && !f.startsWith('_'))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(dir, file), 'utf-8') }));
}

/** Split a heading line into level and text, or null. */
function heading(line) {
  const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  return m ? { level: m[1].length, text: m[2] } : null;
}

/**
 * The lines of a section: from the heading at `start` to the next heading of the same or a
 * higher level, skipping fenced code so a `#` inside a block is not read as a heading.
 */
function sectionAt(lines, start) {
  const own = heading(lines[start]).level;
  let fence = null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const f = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = heading(lines[i]);
    if (h && h.level <= own) {
      end = i;
      break;
    }
  }
  return { heading: heading(lines[start]), body: lines.slice(start + 1, end) };
}

/** Headings outside fenced code, as `{ index, level, text }`. */
function headings(lines) {
  const out = [];
  let fence = null;
  lines.forEach((line, index) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const h = heading(line);
    if (h) out.push({ index, ...h });
  });
  return out;
}

/** A YAML scalar written in quotes (`title: "Act on ..."`) loses them; lint's reader keeps them. */
const unquote = (v) => (typeof v === 'string' && /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v);

/** Parse one PRD into the parts the site shows. */
export function parsePrd({ file, text }) {
  const fm = frontmatter(text) ?? {};
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const lines = body.split('\n');
  const hs = headings(lines);
  const h1 = hs.find((h) => h.level === 1);
  const firstH2 = hs.find((h) => h.level === 2);
  // Whatever stands between the title and the first section (an amendment blockquote, an
  // acceptance or status note) is part of the record, so the page shows all of it.
  const lead = lines.slice(h1 ? h1.index + 1 : 0, firstH2 ? firstH2.index : lines.length);
  const problem = hs.find((h) => h.level === 2 && /^problem$/i.test(h.text));
  const diverged = hs.find((h) => h.level <= 3 && /\bdiverged\b/i.test(h.text));
  // Some PRDs record what the build did under a heading of another name. The site shows that
  // section in the same place, and counts it apart from the "where it diverged" sections.
  const afterShip = diverged ? null : hs.find((h) => h.level <= 3 && AFTER_SHIP.test(h.text));
  return {
    file,
    fm,
    id: fm.id,
    title: unquote(fm.title),
    tier: fm.tier,
    status: fm.status,
    size: fm.size,
    dependsOn: fm.depends_on ?? [],
    blocks: fm.blocks ?? [],
    controls: fm.controls ?? [],
    issue: fm.issue,
    supersededBy: fm.superseded_by,
    lead: lead.some((l) => l.trim()) ? lead : null,
    problem: problem ? sectionAt(lines, problem.index) : null,
    diverged: diverged ? sectionAt(lines, diverged.index) : null,
    afterShip: afterShip ? sectionAt(lines, afterShip.index) : null,
  };
}

// --- Markdown ----------------------------------------------------------------

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** GitHub's heading slug, close enough for ids on our own pages. */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/**
 * A Markdown renderer for the subset docs/prd uses. `ctx.link(url)` maps a link target to
 * the href the site uses; `ctx.shift` moves heading levels; `ctx.ids` dedupes heading ids.
 */
export function renderMarkdown(src, ctx) {
  return blocks(Array.isArray(src) ? src : src.split('\n'), ctx, false);
}

const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const FENCE = /^( *)(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);

function startsBlock(line, next) {
  return (
    /^\s*$/.test(line) ||
    heading(line) ||
    FENCE.test(line) ||
    line.startsWith('>') ||
    /^ {0,3}([-*+]|1[.)]) +\S/.test(line) ||
    (line.trimStart().startsWith('|') && next !== undefined && isTableSep(next))
  );
}

function blocks(lines, ctx, tight) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const indent = fence[1].length;
      const mark = fence[2];
      const code = [];
      i++;
      while (
        i < lines.length &&
        !new RegExp(`^ *${mark[0]}{${mark.length},}\\s*$`).test(lines[i])
      ) {
        code.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ''));
        i++;
      }
      i++;
      const lang = fence[3] ? ` class="language-${esc(fence[3])}"` : '';
      out.push(`<pre><code${lang}>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = heading(line);
    if (h) {
      const level = Math.min(6, Math.max(2, h.level - (ctx.shift ?? 0)));
      const html = inline(h.text, ctx);
      out.push(`<h${level} id="${uniqueId(slug(html), ctx)}">${html}</h${level}>`);
      i++;
      continue;
    }
    if (line.startsWith('>')) {
      const quote = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quote.push(lines[i].replace(/^> ?/, ''));
        i++;
      }
      out.push(`<blockquote>${blocks(quote, ctx, false)}</blockquote>`);
      continue;
    }
    if (line.trimStart().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const cells = (l) =>
        l
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split(/(?<!\\)\|/)
          .map((c) => inline(c.trim().replace(/\\\|/g, '|'), ctx));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|')) rows.push(cells(lines[i++]));
      out.push(
        '<div class="table"><table><thead><tr>' +
          head.map((c) => `<th>${c}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') +
          '</tbody></table></div>',
      );
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item && item[1].length < 4) {
      const [html, next] = list(lines, i, ctx);
      out.push(html);
      i = next;
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++].trim());
    const html = inline(para.join('\n'), ctx);
    out.push(tight ? html : `<p>${html}</p>`);
  }
  return out.join('\n');
}

function list(lines, start, ctx) {
  const first = LIST_ITEM.exec(lines[start]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  let loose = false;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = indent + m[2].length + Math.max(1, Math.min(m[3].length, 4));
    const body = [m[4]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) {
        // A blank line stays in the item only if the item continues after it.
        let j = i;
        while (j < lines.length && /^\s*$/.test(lines[j])) j++;
        if (j < lines.length && lines[j].search(/\S/) >= contentIndent) {
          body.push(...lines.slice(i, j).map(() => ''));
          i = j;
          loose = true;
          continue;
        }
        break;
      }
      const lead = l.search(/\S/);
      if (lead >= contentIndent) {
        body.push(l.slice(contentIndent));
      } else if (LIST_ITEM.test(l) || heading(l) || FENCE.test(l) || l.startsWith('>')) {
        break;
      } else {
        body.push(l.trim()); // lazy continuation of the item's paragraph
      }
      i++;
    }
    items.push(body);
    // A blank line between items makes the list loose.
    let j = i;
    while (j < lines.length && /^\s*$/.test(lines[j])) j++;
    const nextItem = j < lines.length && LIST_ITEM.exec(lines[j]);
    if (nextItem && nextItem[1].length === indent && /\d/.test(nextItem[2]) === ordered) {
      if (j > i) loose = true;
      i = j;
    } else break;
  }
  const lis = items.map((body) => {
    let check = '';
    const task = /^\[([ xX])\] (.*)$/.exec(body[0]);
    if (task) {
      check = `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'} aria-label="${task[1] === ' ' ? 'not done' : 'done'}"> `;
      body = [task[2], ...body.slice(1)];
    }
    return `<li>${check}${blocks(body, ctx, !loose)}</li>`;
  });
  const startNo = ordered ? parseInt(first[2], 10) : 1;
  const tag = ordered ? 'ol' : 'ul';
  const attr = ordered && startNo !== 1 ? ` start="${startNo}"` : '';
  return [`<${tag}${attr}>${lis.join('\n')}</${tag}>`, i];
}

function uniqueId(base, ctx) {
  ctx.ids ??= new Map();
  const n = ctx.ids.get(base) ?? 0;
  ctx.ids.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

/** Inline Markdown: code spans and links are lifted out first, so emphasis can wrap them. */
function inline(text, ctx) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let s = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && /[\\`*_[\]()#|<>!-]/.test(text[i + 1] ?? '')) {
      s += hold(esc(text[i + 1]));
      i += 2;
      continue;
    }
    if (c === '`') {
      const ticks = /^`+/.exec(text.slice(i))[0];
      const close = closingTicks(text, i + ticks.length, ticks.length);
      if (close !== -1) {
        let code = text.slice(i + ticks.length, close).replace(/\n/g, ' ');
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        s += hold(`<code>${esc(code)}</code>`);
        i = close + ticks.length;
        continue;
      }
    }
    if (c === '[') {
      const link = matchLink(text, i);
      if (link) {
        const href = ctx.link(link.url);
        s += hold(`<a href="${esc(href)}">${inline(link.label, ctx)}</a>`);
        i = link.end;
        continue;
      }
    }
    if (c === '<') {
      const auto = /^<(https?:\/\/[^\s>]+)>/.exec(text.slice(i));
      if (auto) {
        s += hold(`<a href="${esc(auto[1])}">${esc(auto[1])}</a>`);
        i += auto[0].length;
        continue;
      }
    }
    const bare = /^https?:\/\/[^\s<>()]+[^\s<>().,;:'"]/.exec(text.slice(i));
    if (bare && !/[\w/]/.test(text[i - 1] ?? '')) {
      s += hold(`<a href="${esc(bare[0])}">${esc(bare[0])}</a>`);
      i += bare[0].length;
      continue;
    }
    s += c;
    i++;
  }
  s = esc(s)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*(?=\S)([\s\S]*?\S)\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => held[Number(n)]);
}

/** Where a code span opened by `n` backticks closes: the next run of exactly `n`, or -1. */
function closingTicks(text, from, n) {
  const re = /`+/g;
  re.lastIndex = from;
  for (let m; (m = re.exec(text));) if (m[0].length === n) return m.index;
  return -1;
}

/** `[label](url)` at `i`, with nested brackets in the label and parentheses in the url. */
function matchLink(text, i) {
  let depth = 0;
  let j = i;
  for (; j < text.length; j++) {
    if (text[j] === '\\') {
      j++;
      continue;
    }
    if (text[j] === '`') {
      const ticks = /^`+/.exec(text.slice(j))[0];
      const close = text.indexOf(ticks, j + ticks.length);
      if (close !== -1) j = close + ticks.length - 1;
      continue;
    }
    if (text[j] === '[') depth++;
    else if (text[j] === ']' && --depth === 0) break;
  }
  if (depth !== 0 || text[j + 1] !== '(') return null;
  let k = j + 2;
  let paren = 1;
  for (; k < text.length; k++) {
    if (text[k] === '(') paren++;
    else if (text[k] === ')' && --paren === 0) break;
    else if (/\s/.test(text[k]) && text[k] !== ' ') return null;
  }
  if (paren !== 0) return null;
  const url = text
    .slice(j + 2, k)
    .trim()
    .replace(/\s+"[^"]*"$/, '');
  return { label: text.slice(i + 1, j), url, end: k + 1 };
}

// --- Links -------------------------------------------------------------------

/**
 * Where a link in a PRD goes on the site. Another PRD becomes its page here; anything else
 * in the repo goes to the file on GitHub at main; external links are left alone.
 */
export function makeLinker(prd, byFile) {
  return (url) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    const [path, hash] = url.split('#');
    if (!path) return `${REPO_URL}/blob/main/${PRD_DIR}/${prd.file}#${hash}`;
    const repoPath = posix.normalize(posix.join(PRD_DIR, path));
    const target = byFile.get(posix.basename(repoPath));
    if (target && posix.dirname(repoPath) === PRD_DIR) return pageName(target);
    return `${REPO_URL}/blob/main/${repoPath}${hash ? `#${hash}` : ''}`;
  };
}

const pageName = (prd) => `${prd.id}.html`;

// --- Graph -------------------------------------------------------------------

/** Every prerequisite edge, from `depends_on` and `blocks` together, deduplicated. */
export function edges(prds) {
  const set = new Set();
  for (const p of prds) {
    for (const d of p.dependsOn) set.add(`${d}>${p.id}`);
    for (const b of p.blocks) set.add(`${p.id}>${b}`);
  }
  return [...set].sort().map((e) => e.split('>'));
}

function graphSvg(prds) {
  const W = 118;
  const H = 46;
  const GAP = 14;
  const ROW = 120;
  const PAD = 24;
  const tiers = [...new Set(prds.map((p) => Number(p.tier)))].sort((a, b) => a - b);
  const rows = tiers.map((t) => prds.filter((p) => Number(p.tier) === t));
  const widest = Math.max(...rows.map((r) => r.length));
  const width = PAD * 2 + 64 + widest * W + (widest - 1) * GAP;
  const height = PAD * 2 + (rows.length - 1) * ROW + H;
  const pos = new Map();
  rows.forEach((row, r) => {
    const rowWidth = row.length * W + (row.length - 1) * GAP;
    const x0 = PAD + 64 + (widest * W + (widest - 1) * GAP - rowWidth) / 2;
    row.forEach((p, c) => pos.set(p.id, { x: x0 + c * (W + GAP), y: PAD + r * ROW }));
  });
  const lines = [];
  for (const [from, to] of edges(prds)) {
    const a = pos.get(from);
    const b = pos.get(to);
    if (!a || !b) continue;
    let d;
    if (a.y < b.y) {
      const [x1, y1, x2, y2] = [a.x + W / 2, a.y + H, b.x + W / 2, b.y - 3];
      d = `M${x1} ${y1} C${x1} ${y1 + 45} ${x2} ${y2 - 45} ${x2} ${y2}`;
    } else if (a.y > b.y) {
      const [x1, y1, x2, y2] = [a.x + W / 2, a.y, b.x + W / 2, b.y + H + 3];
      d = `M${x1} ${y1} C${x1} ${y1 - 45} ${x2} ${y2 + 45} ${x2} ${y2}`;
    } else {
      const [x1, x2, y] = [a.x + W / 2, b.x + W / 2, a.y - 3];
      d = `M${x1} ${a.y} C${x1} ${y - 34} ${x2} ${y - 34} ${x2} ${y}`;
    }
    lines.push(
      `<path class="edge" d="${d}" marker-end="url(#arrow)"><title>${esc(from)} before ${esc(to)}</title></path>`,
    );
  }
  const labels = rows.map(
    (row, r) =>
      `<text class="tier" x="${PAD}" y="${PAD + r * ROW + H / 2 + 4}">Tier ${esc(row[0].tier)}</text>`,
  );
  const nodes = prds.map((p) => {
    const { x, y } = pos.get(p.id);
    const status = STATUS_LABEL[p.status] ?? p.status;
    const note = p.diverged ? `${status}, diverged` : status;
    return (
      `<a href="${pageName(p)}" class="node s-${esc(p.status)}" aria-label="${esc(`${p.id}: ${p.title.replace(/`/g, '')} (${note})`)}">` +
      `<title>${esc(`${p.id}: ${p.title.replace(/`/g, '')}`)}</title>` +
      `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="${p.status === 'shipped' ? 3 : 14}"/>` +
      `<text class="id" x="${x + W / 2}" y="${y + 19}">${esc(p.id)}</text>` +
      `<text class="st" x="${x + W / 2}" y="${y + 36}">${esc(note)}</text></a>`
    );
  });
  return (
    `<svg class="graph" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="group" aria-labelledby="graph-title">` +
    `<title id="graph-title">Dependency graph of every PRD, one row per tier. An arrow runs from a PRD to one that depends on it.</title>` +
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker></defs>` +
    `<g class="edges">${lines.join('')}</g>${labels.join('')}${nodes.join('')}</svg>`
  );
}

// --- Pages -------------------------------------------------------------------

const CSS = `
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#5d5d58;--line:#d6d3cb;--panel:#f1efe9;--accent:#1f5f8b;--edge:#8d8a82}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#a8a69f;--line:#3a3935;--panel:#1e1e1c;--accent:#8cc4ec;--edge:#77756e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main,header,footer{max-width:1280px;margin:0 auto;padding:0 20px}
header{padding-top:18px;font-size:14px;color:var(--muted)}
header a{color:var(--muted)}
footer{padding:32px 20px 40px;font-size:14px;color:var(--muted)}
a{color:var(--accent)}
h1{font-size:1.9rem;line-height:1.2;margin:.6em 0 .3em}
h2{font-size:1.3rem;margin:1.6em 0 .5em}
h3{font-size:1.08rem;margin:1.4em 0 .4em}
h4,h5,h6{font-size:1rem;margin:1.2em 0 .3em}
code{font:.88em/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--panel);padding:.05em .12em;border-radius:3px;overflow-wrap:anywhere}
pre{background:var(--panel);padding:12px 14px;border-radius:6px;overflow-x:auto}
pre code{background:none;padding:0;overflow-wrap:normal}
blockquote{margin:1em 0;padding:.2em 1em;border-left:4px solid var(--line);color:var(--fg)}
.table{overflow-x:auto}
table{border-collapse:collapse;margin:1em 0;font-size:.94em}
th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}
th{background:var(--panel)}
.lede{max-width:72ch;font-size:1.06rem}
.meta{color:var(--muted)}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:28px;align-items:start}
.pair>section{min-width:0;border-top:3px solid var(--line);padding-top:4px}
.pair>section>h2:first-child{margin-top:.6em}
.note{font-style:italic;color:var(--muted)}
.amend{background:var(--panel);border-radius:6px;padding:4px 16px;margin:1em 0}
.amend>p.label{font-size:.9em;color:var(--muted);margin:.8em 0 0}
dl.facts{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:2em 0;padding-top:16px;border-top:1px solid var(--line)}
dl.facts dt{color:var(--muted)}
dl.facts dd{margin:0}
.graph-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px;padding:6px;margin:1em 0}
svg.graph{display:block;width:100%;height:auto;min-width:900px;font-family:inherit}
svg.graph .edge{fill:none;stroke:var(--edge);stroke-width:1.1;opacity:.75}
svg.graph marker path{fill:var(--edge)}
svg.graph .tier{fill:var(--muted);font-size:13px}
svg.graph .node rect{fill:var(--bg);stroke:var(--fg);stroke-width:1.6}
svg.graph .node.s-in-progress rect{stroke-dasharray:6 4}
svg.graph .node.s-accepted rect,svg.graph .node.s-draft rect{stroke-dasharray:2 3}
svg.graph .node.s-superseded rect{stroke:var(--muted)}
svg.graph .node text{text-anchor:middle;fill:var(--fg)}
svg.graph .node .id{font-size:14px;font-weight:600}
svg.graph .node .st{font-size:11px;fill:var(--muted)}
svg.graph .node:hover rect,svg.graph .node:focus rect{stroke:var(--accent);stroke-width:2.6}
.legend{font-size:14px;color:var(--muted)}
.hint{display:none;font-size:14px;color:var(--muted)}
td.num{white-space:nowrap}
@media (max-width:760px){.hint{display:block}.pair{grid-template-columns:1fr}h1{font-size:1.5rem}dl.facts{grid-template-columns:1fr}dl.facts dd{margin-bottom:8px}}
`;

function page({ title, body, depth = 0, description }) {
  void depth;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<style>${CSS.trim()}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function header() {
  return `<header><a href="index.html">Specced vs shipped</a> · PRDs of <a href="${REPO_URL}">agent-native-monorepo</a></header>`;
}

function footer(commit) {
  const at = commit
    ? `Built from commit <a href="${REPO_URL}/tree/${commit}"><code>${commit.slice(0, 7)}</code></a>`
    : 'Built from the working tree';
  return `<footer>${at}. Generated from <a href="${REPO_URL}/tree/main/${PRD_DIR}"><code>${PRD_DIR}</code></a> by <a href="${REPO_URL}/blob/main/scripts/prd-site.mjs"><code>scripts/prd-site.mjs</code></a>.</footer>`;
}

const idLinks = (ids, byId) =>
  ids.length
    ? ids
        .map((id) =>
          byId.has(id) ? `<a href="${pageName(byId.get(id))}">${esc(id)}</a>` : esc(id),
        )
        .join(', ')
    : 'none';

function prdPage(p, byId, byFile, commit) {
  const ctx = { link: makeLinker(p, byFile), ids: new Map([['top', 1]]) };
  const status = STATUS_LABEL[p.status] ?? p.status;
  const sec = (s) => renderMarkdown(s.body, { ...ctx, shift: s.heading.level - 2 });
  const problem = p.problem
    ? `<h2 id="problem">The problem, as specced</h2>\n${sec(p.problem)}`
    : `<h2 id="problem">The problem, as specced</h2><p class="note">This PRD has no Problem section.</p>`;
  let shipped;
  if (p.diverged) {
    ctx.ids.set('shipped', 1);
    shipped = `<h2 id="shipped">${inline(p.diverged.heading.text, ctx)}</h2>\n${sec(p.diverged)}`;
  } else if (p.afterShip) {
    ctx.ids.set('shipped', 1);
    const lead =
      p.status === 'shipped'
        ? 'This PRD has no section on where it diverged. It records what the build did under this heading instead:'
        : `Not shipped yet (status "${esc(status)}"). It already records what the implementation has done so far under this heading:`;
    shipped = `<p class="note">${lead}</p>\n<h2 id="shipped">${inline(p.afterShip.heading.text, ctx)}</h2>\n${sec(p.afterShip)}`;
  } else {
    const why =
      p.status === 'shipped'
        ? 'Shipped, with no section on where the build diverged from the design. The full PRD is linked below.'
        : `Not shipped yet: the PRD's status is "${esc(status)}", and a divergence section is written when it ships.`;
    shipped = `<h2 id="shipped">What shipped, and where it diverged</h2><p class="note">${why}</p>`;
  }
  const amendment = p.lead
    ? `<div class="amend"><p class="label">At the top of the PRD, as written:</p>${renderMarkdown(p.lead, ctx)}</div>`
    : '';
  const fileUrl = `${REPO_URL}/blob/main/${PRD_DIR}/${p.file}`;
  const historyUrl = `${REPO_URL}/commits/main/${PRD_DIR}/${p.file}`;
  const facts = [
    ['Status', esc(status)],
    ['Tier', esc(p.tier)],
    ['Size', esc(p.size)],
    ['Depends on', idLinks(p.dependsOn, byId)],
    ['Blocks', idLinks(p.blocks, byId)],
    [
      'Controls',
      p.controls.length
        ? p.controls
            .map(
              (c) =>
                `<a href="${REPO_URL}/blob/main/governance/controls.yaml"><code>${esc(c)}</code></a>`,
            )
            .join(', ')
        : 'none',
    ],
    ...(p.issue
      ? [['Issue', `<a href="${REPO_URL}/issues/${esc(p.issue)}">#${esc(p.issue)}</a>`]]
      : []),
    ...(p.supersededBy ? [['Superseded by', idLinks([p.supersededBy], byId)]] : []),
    ['The PRD', `<a href="${fileUrl}"><code>${esc(`${PRD_DIR}/${p.file}`)}</code> on GitHub</a>`],
    ['History', `<a href="${historyUrl}">Every commit to this file</a>`],
  ];
  const body = `${header()}
<main id="top">
<h1>${esc(p.id)} · ${inline(p.title, ctx)}</h1>
<p class="meta">Tier ${esc(p.tier)}, size ${esc(p.size)}, ${esc(status)}.</p>
${amendment}
<div class="pair">
<section class="spec">
${problem}
</section>
<section class="shipped">
${shipped}
</section>
</div>
<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
</main>
${footer(commit)}`;
  return page({
    title: `${p.id}: ${p.title.replace(/`/g, '')} · Specced vs shipped`,
    description: `The problem ${p.id} set out to solve, beside what shipped and where it diverged.`,
    body,
  });
}

function count(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function indexPage(prds, commit) {
  const ctx = { link: () => '#', ids: new Map() };
  const byStatus = STATUS_ORDER.map((s) => [s, prds.filter((p) => p.status === s).length]).filter(
    ([, n]) => n,
  );
  const unknown = prds.filter((p) => !STATUS_ORDER.includes(p.status)).length;
  const diverged = prds.filter((p) => p.diverged).length;
  const shipped = prds.filter((p) => p.status === 'shipped');
  const otherName = prds.filter((p) => p.afterShip);
  const shippedNeither = shipped.filter((p) => !p.diverged && !p.afterShip).length;
  const statusLine = byStatus.map(([s, n]) => `${n} ${STATUS_LABEL[s]}`).join(', ');
  const rows = prds
    .map(
      (p) =>
        `<tr><td class="num"><a href="${pageName(p)}">${esc(p.id)}</a></td><td>${inline(p.title, ctx)}</td>` +
        `<td>${esc(p.tier)}</td><td>${esc(STATUS_LABEL[p.status] ?? p.status)}</td><td>${esc(p.size)}</td>` +
        `<td>${p.diverged ? 'yes' : p.afterShip ? `under another heading: ${inline(p.afterShip.heading.text, ctx)}` : 'no'}</td></tr>`,
    )
    .join('\n');
  const body = `${header()}
<main>
<h1>Specced vs shipped</h1>
<p class="lede">I write a PRD before every feature in <a href="${REPO_URL}">agent-native-monorepo</a>, and when one ships I add a section on what shipped and where it diverged from the design. Each page here puts a PRD's Problem beside that section. There are ${count(prds.length, 'PRD', 'PRDs')} so far, ${shipped.length} of them shipped; ${diverged} have a section on where it diverged, and ${otherName.length} more record what the build did under another heading.</p>
<h2 id="graph">How they depend on each other</h2>
<p class="legend">One row per tier. An arrow runs from a PRD to one that depends on it. A square-cornered box is shipped, a dashed rounded box is in progress, a dotted rounded box is accepted or a draft; the second line of each box says the status in words, and "diverged" when the PRD has a divergence section. Every box links to its page.</p>
<p class="hint">The graph is wider than this screen: scroll it sideways.</p>
<div class="graph-wrap">${graphSvg(prds)}</div>
<h2 id="counts">The counts</h2>
<ul>
<li>${count(prds.length, 'PRD', 'PRDs')}: ${statusLine}${unknown ? `, ${unknown} with an unrecognised status` : ''}.</li>
<li>${count(diverged, 'has', 'have')} a section on what shipped and where it diverged.</li>
<li>${count(otherName.length, 'more records', 'more record')} what the build did under a heading of another name (${otherName.map((p) => `<a href="${pageName(p)}">${esc(p.id)}</a>`).join(', ') || 'none'}).</li>
<li>${count(shippedNeither, 'shipped PRD has', 'shipped PRDs have')} neither.</li>
<li>${count(edges(prds).length, 'dependency edge', 'dependency edges')} between them.</li>
</ul>
<h2 id="all">Every PRD</h2>
<div class="table"><table><thead><tr><th>Id</th><th>Title</th><th>Tier</th><th>Status</th><th>Size</th><th>Divergence section</th></tr></thead><tbody>
${rows}
</tbody></table></div>
<h2 id="template">The format</h2>
<p class="lede">Every PRD starts from the same template: Problem, Why it matters, Scope and non-goals, Design, Acceptance criteria, Risks and open questions, References, with the frontmatter the graph above is drawn from. The divergence section is added when the work ships. The design above it is not rewritten to match the code; a later change to it is dated and marked in place. If you want the format, <a href="${REPO_URL}/blob/main/${PRD_DIR}/_TEMPLATE.md">the template is in the repo</a>, and so is <a href="${REPO_URL}/blob/main/${PRD_DIR}/README.md">the index</a>.</p>
</main>
${footer(commit)}`;
  return page({
    title: 'Specced vs shipped: the PRDs of agent-native-monorepo',
    description: `${prds.length} PRDs, each one's problem beside what shipped and where it diverged.`,
    body,
  });
}

// --- Build and check -------------------------------------------------------------

/** Build every page in memory. Returns `{ pages: Map<name, html>, problems: string[] }`. */
export function buildSite(files, { commit = null, repoRoot = root } = {}) {
  const problems = [];
  const prds = files.map(parsePrd);
  for (const p of prds) {
    for (const key of REQUIRED) {
      if (p.fm[key] === undefined || p.fm[key] === null)
        problems.push(`${p.file}: frontmatter is missing \`${key}\``);
    }
  }
  const valid = prds.filter((p) => REQUIRED.every((k) => p.fm[k] != null));
  valid.sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(valid.map((p) => [p.id, p]));
  const byFile = new Map(valid.map((p) => [p.file, p]));
  for (const p of valid) {
    for (const [field, ids] of [
      ['depends_on', p.dependsOn],
      ['blocks', p.blocks],
    ]) {
      for (const id of ids)
        if (!byId.has(id)) problems.push(`${p.file}: ${field} names ${id}, which is no PRD`);
    }
  }
  const pages = new Map();
  pages.set('index.html', indexPage(valid, commit));
  for (const p of valid) pages.set(pageName(p), prdPage(p, byId, byFile, commit));
  const given = new Set(files.map((f) => `${PRD_DIR}/${f.file}`));
  problems.push(...checkLinks(pages, repoRoot, given));
  return { pages, prds: valid, problems };
}

/**
 * Every link the site makes that should resolve locally: a page of its own, an id on a page,
 * or a path in this repo behind a GitHub blob, tree or commits link. A PRD file the build was
 * given counts as present, so the tests can build from files that are not on disk.
 */
export function checkLinks(pages, repoRoot = root, given = new Set()) {
  const problems = [];
  const ids = new Map();
  for (const [name, html] of pages)
    ids.set(name, new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])));
  const repoPrefix = new RegExp(
    `^${REPO_URL.replace(/[.]/g, '\\.')}/(?:blob|tree|commits)/main/([^#]*)`,
  );
  for (const [name, html] of pages) {
    for (const [, raw] of html.matchAll(/ href="([^"]*)"/g)) {
      const href = raw.replace(/&amp;/g, '&');
      if (href === '#') {
        problems.push(`${name}: a link with no target`);
        continue;
      }
      const repo = repoPrefix.exec(href);
      if (repo) {
        const path = decodeURIComponent(repo[1]).replace(/\/$/, '');
        if (path && !given.has(path) && !existsSync(join(repoRoot, path)))
          problems.push(`${name}: links ${path}, which is not in the repo`);
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      const [file, hash] = href.split('#');
      const target = file || name;
      if (!pages.has(target))
        problems.push(`${name}: links ${href}, which the site does not build`);
      else if (hash && !ids.get(target).has(hash))
        problems.push(`${name}: links ${href}, and ${target} has no id "${hash}"`);
    }
  }
  return problems;
}

function headCommit(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function main() {
  const { values } = parseArgs({
    options: { out: { type: 'string', default: 'dist/prd-site' }, check: { type: 'boolean' } },
  });
  const { pages, prds, problems } = buildSite(readPrdFiles(), { commit: headCommit(root) });
  if (problems.length) {
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(`prd-site: ${problems.length} problem(s)`);
    process.exit(1);
  }
  const diverged = prds.filter((p) => p.diverged).length;
  if (values.check) {
    console.log(
      `prd-site: ${prds.length} PRDs, ${diverged} with a divergence section, ${pages.size} pages, links resolve`,
    );
    return;
  }
  const out = join(root, values.out);
  if (
    !out.startsWith(join(root, '/')) ||
    out === root ||
    /(^|\/)(docs|scripts|packages|apps)$/.test(values.out)
  )
    throw new Error(`prd-site: refusing to clear ${values.out}; pick an output folder of its own`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const [name, html] of pages) writeFileSync(join(out, name), html);
  writeFileSync(join(out, '.nojekyll'), '');
  console.log(
    `prd-site: wrote ${pages.size} pages to ${values.out} (${prds.length} PRDs, ${diverged} with a divergence section)`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

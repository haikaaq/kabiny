// Ежедневное обновление цен: перечитывает страницы конкурентов и обновляет data/prices.json.
//   node scripts/update.mjs            — обновить цены и записать изменения
//   node scripts/update.mjs --check    — только проверить, ничего не записывать (отчёт в консоль)
//   node scripts/update.mjs --only=str — только один конкурент
// Модель обновляется, только если страница открылась И цена нашлась. Иначе остаётся прежняя цена
// с отметкой, что автопроверка не прошла (и причиной). Резкие скачки (больше чем вдвое) не применяются
// автоматически, а помечаются «на проверку» — чаще всего это значит, что на странице поменялась вёрстка.
import fs from 'node:fs';
import { fetchText, findPrice, htmlToText, norm, structuredPrice } from './lib.mjs';

const FILE = new URL('./prices.json', import.meta.url);
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
const RUNNER = process.env.RUNNER_NAME_RU || (process.env.GITHUB_ACTIONS ? 'GitHub Actions' : 'вручную');

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const now = new Date();
const today = now.toISOString().slice(0, 10);

function extract(html, item) {
  const ext = item.ext || {};
  if (ext.mode === 'auto') {
    const s = structuredPrice(html);
    if (s && s.price > 10000) return { ok: true, price: s.price, how: s.how };
    // цена в карточке стоит сразу после заголовка h1 — берём первую цену после «своего» h1
    const heads = [...html.matchAll(/<h1[\s>][\s\S]*?<\/h1>/gi)].map((m) => ({ at: m.index, t: norm(htmlToText(m[0])) }));
    const a = ext.anchor ? norm(ext.anchor).slice(0, 25) : '';
    const h = heads.find((x) => a && x.t.includes(a)) || heads.filter((x) => x.t.length > 3).pop();
    const text = htmlToText(h ? html.slice(h.at) : html);
    const r = findPrice(text, null, { maxDist: 3000 });
    return r.ok ? { ...r, how: 'after-h1' } : r;
  }
  const text = htmlToText(html, { keepScripts: !!ext.json });
  return findPrice(text, ext.anchor, { nth: ext.nth || 1, json: !!ext.json });
}

// группируем по адресу страницы, чтобы каждую страницу качать один раз
const byUrl = new Map();
for (const it of data.items) {
  if (ONLY && it.c !== ONLY) continue;
  if (!byUrl.has(it.url)) byUrl.set(it.url, []);
  byUrl.get(it.url).push(it);
}

const urls = [...byUrl.keys()];
const pages = new Map();
const LIMIT = 8; // всего одновременно
const PER_HOST = 2; // на один сайт одновременно — чтобы не получить бан
const busy = {};
const host = (u) => new URL(u).hostname;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const queue = [...urls];
async function worker() {
  while (queue.length) {
    const i = queue.findIndex((u) => (busy[host(u)] || 0) < PER_HOST);
    if (i < 0) { await sleep(200); continue; }
    const u = queue.splice(i, 1)[0];
    const h = host(u);
    busy[h] = (busy[h] || 0) + 1;
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await fetchText(u, { raw: true });
      if (r.ok || !['fetch_failed', 'http_429', 'http_502', 'http_503'].includes(r.reason)) break;
      await sleep(2500 * (attempt + 1));
    }
    busy[h]--;
    pages.set(u, r);
  }
}
await Promise.all(Array.from({ length: LIMIT }, worker));

const stats = { pages: urls.length, pagesOk: 0, items: 0, ok: 0, changed: 0, failed: 0, suspicious: 0 };
const changes = [];
const perComp = {};
for (const [u, items] of byUrl) {
  const page = pages.get(u);
  if (page.ok) stats.pagesOk++;
  for (const it of items) {
    stats.items++;
    perComp[it.c] ??= { ok: 0, fail: 0 };
    if (!page.ok) {
      it.auto = { ok: false, reason: page.reason, at: now.toISOString(), by: RUNNER };
      stats.failed++;
      perComp[it.c].fail++;
      continue;
    }
    const r = extract(page.text, it);
    if (!r.ok) {
      it.auto = { ok: false, reason: r.reason, at: now.toISOString(), by: RUNNER };
      stats.failed++;
      perComp[it.c].fail++;
      if (CHECK) console.log(`  ✗ ${it.id} ${it.model} — ${r.reason}`);
      continue;
    }
    perComp[it.c].ok++;
    stats.ok++;
    const old = it.price;
    const ratio = r.price / old;
    if (r.price !== old && (ratio > 2 || ratio < 0.5)) {
      stats.suspicious++;
      it.auto = { ok: true, suspicious: r.price, at: now.toISOString(), by: RUNNER };
      if (CHECK) console.log(`  ? ${it.id} ${it.model}: было ${old}, нашлось ${r.price} — НА ПРОВЕРКУ (${r.context || r.how})`);
      continue;
    }
    it.auto = { ok: true, at: now.toISOString(), by: RUNNER };
    it.checked = today;
    if (r.price !== old) {
      stats.changed++;
      changes.push({ date: today, id: it.id, c: it.c, model: it.model, from: old, to: r.price });
      it.price = r.price;
      it.changed = today;
      it.hist = [...(it.hist || []), [today, r.price]].slice(-24);
      if (CHECK) console.log(`  ↻ ${it.id} ${it.model}: ${old} → ${r.price}`);
    }
  }
}

console.log(`Страниц: ${stats.pagesOk}/${stats.pages} открылись; моделей проверено ${stats.ok}/${stats.items}, изменилось ${stats.changed}, на проверку ${stats.suspicious}`);
for (const [c, s] of Object.entries(perComp)) console.log(`  ${c.padEnd(11)} ok ${String(s.ok).padStart(3)}  не прочитано ${s.fail}`);

if (!CHECK) {
  data.updated_at = now.toISOString();
  data.changes = [...changes, ...(data.changes || [])].slice(0, 500);
  data.runs = [{ at: now.toISOString(), by: RUNNER, ...stats }, ...(data.runs || [])].slice(0, 60);
  fs.writeFileSync(FILE, JSON.stringify(data, null, 1) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`### Обновление цен ${today}`, `Проверено моделей: ${stats.ok} из ${stats.items}. Изменилось: ${stats.changed}.`, ''];
    for (const ch of changes) lines.push(`- ${ch.model}: ${ch.from.toLocaleString('ru')} → ${ch.to.toLocaleString('ru')} ₽`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
}

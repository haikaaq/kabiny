// Ежедневное обновление цен: перечитывает страницы конкурентов, обновляет prices.json и ведёт историю цен.
//   node update.mjs            — обновить цены, записать изменения и историю
//   node update.mjs --check    — только проверить, ничего не записывать (отчёт в консоль)
//   node update.mjs --only=str — только один конкурент
// Модель обновляется, только если страница открылась И цена нашлась. Иначе остаётся прежняя цена
// с отметкой, что автопроверка не прошла (и причиной). Резкие скачки (больше чем вдвое) не применяются
// автоматически, а помечаются «на проверку» — чаще всего это значит, что на странице поменялась вёрстка.
//
// История цен:
//   history.json — по каждой модели список точек [дата, цена]: первая точка — с какого дня модель в таблице,
//                  дальше — только дни, когда цена поменялась. Модели, убранные из таблицы, остаются с датой removed.
//                  checks — сколько моделей удалось проверить в каждый день.
//   history.csv  — тот же журнал изменений одной таблицей (открывается в Excel).
import fs from 'node:fs';
import { fetchText, findPrice, htmlToText, norm, structuredPrice } from './lib.mjs';
import { updateHistory } from './history.mjs';

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
  if (ext.mode === 'regex') {
    // цена из разметки страницы по шаблону (например, карточка товара или конфигуратор LWOP)
    const m = html.match(new RegExp(ext.re));
    const price = m ? Number(m[1].replace(/\D/g, '')) : 0;
    return price > 10000 ? { ok: true, price, how: 'regex' } : { ok: false, reason: 'price_not_found' };
  }
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
const LIMIT = 6; // всего одновременно
// на один сайт — по одной странице с паузой: при частых запросах сайты (STR) отвечают 503
const PER_HOST = 1;
const GAP_MS = 1500;
const RETRY = ['fetch_failed', 'http_403', 'timeout', 'http_429', 'http_500', 'http_502', 'http_503', 'http_504'];
const busy = {};
const lastHit = {};
const host = (u) => new URL(u).hostname;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function crawl(list, gap) {
  const queue = [...list];
  async function worker() {
    while (queue.length) {
      const now = Date.now();
      const i = queue.findIndex((u) => (busy[host(u)] || 0) < PER_HOST && now - (lastHit[host(u)] || 0) >= gap);
      if (i < 0) { await sleep(200); continue; }
      const u = queue.splice(i, 1)[0];
      const h = host(u);
      busy[h] = (busy[h] || 0) + 1;
      let r;
      for (let attempt = 0; attempt < 3; attempt++) {
        r = await fetchText(u, { raw: true });
        if (r.ok || !RETRY.includes(r.reason)) break;
        await sleep(5000 * (attempt + 1));
      }
      lastHit[h] = Date.now();
      busy[h]--;
      pages.set(u, r);
    }
  }
  await Promise.all(Array.from({ length: LIMIT }, worker));
}
await crawl(urls, GAP_MS);
// второй заход по страницам, которые не открылись: через минуту и медленнее
const again = urls.filter((u) => !pages.get(u).ok && RETRY.includes(pages.get(u).reason));
if (again.length) {
  console.log(`Повторная попытка: ${again.length} страниц`);
  await sleep(60000);
  await crawl(again, 4000);
}

const stats = { pages: urls.length, pagesOk: 0, items: 0, ok: 0, changed: 0, failed: 0, suspicious: 0 };
const changes = [];
const perComp = {};
for (const [u, items] of byUrl) {
  const page = pages.get(u);
  if (page.ok) stats.pagesOk++;
  else console.log(`  ✗ ${u} — ${page.reason}${page.error ? ' (' + page.error + ')' : ''}`);
  for (const it of items) {
    stats.items++;
    perComp[it.c] ??= { ok: 0, fail: 0 };
    if (!page.ok) {
      it.auto = { ok: false, reason: page.reason, ...(page.error ? { error: page.error } : {}), at: now.toISOString(), by: RUNNER };
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
      if (CHECK) console.log(`  ↻ ${it.id} ${it.model}: ${old} → ${r.price}`);
    }
  }
}

console.log(`Страниц: ${stats.pagesOk}/${stats.pages} открылись; моделей проверено ${stats.ok}/${stats.items}, изменилось ${stats.changed}, на проверку ${stats.suspicious}`);
for (const [c, s] of Object.entries(perComp)) console.log(`  ${c.padEnd(11)} ok ${String(s.ok).padStart(3)}  не прочитано ${s.fail}`);

if (!CHECK) {
  data.updated_at = now.toISOString();
  delete data.changes;
  for (const it of data.items) delete it.hist;
  data.runs = [{ at: now.toISOString(), by: RUNNER, ...stats }, ...(data.runs || [])].slice(0, 60);
  fs.writeFileSync(FILE, JSON.stringify(data, null, 1) + '\n');
  updateHistory(data, today, ONLY ? null : stats);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`### Обновление цен ${today}`, `Проверено моделей: ${stats.ok} из ${stats.items}. Изменилось: ${stats.changed}.`, ''];
    for (const ch of changes) lines.push(`- ${ch.model}: ${ch.from.toLocaleString('ru')} → ${ch.to.toLocaleString('ru')} ₽`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
}

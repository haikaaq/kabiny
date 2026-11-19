// История цен: history.json (точки изменения цены по каждой модели) и history.csv (журнал изменений).
// Цены в истории — как на сайте конкурента. НДС для тех, кто показывает цены без НДС (vat_excl),
// прибавляет уже страница при показе, чтобы история не менялась, если поменяется ставка.
import fs from 'node:fs';

const JSON_FILE = new URL('./history.json', import.meta.url);
const CSV_FILE = new URL('./history.csv', import.meta.url);

export function loadHistory() {
  if (!fs.existsSync(JSON_FILE)) return { start: null, items: {}, checks: [] };
  return JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
}

export function updateHistory(data, today, stats) {
  const h = loadHistory();
  h.start ??= today;
  const ids = new Set();
  for (const it of data.items) {
    ids.add(it.id);
    const rec = (h.items[it.id] ??= { c: it.c, model: it.model, cls: it.cls, p: [] });
    rec.c = it.c; rec.model = it.model; rec.cls = it.cls; rec.url = it.url;
    if (rec.removed) delete rec.removed; // модель вернули в таблицу
    const last = rec.p[rec.p.length - 1];
    if (!last) rec.p.push([today, it.price]);
    else if (last[1] !== it.price) {
      if (last[0] === today) last[1] = it.price; // за один день храним последнюю цену
      else rec.p.push([today, it.price]);
    }
  }
  for (const [id, rec] of Object.entries(h.items)) if (!ids.has(id) && !rec.removed) rec.removed = today;
  if (stats) {
    h.checks = (h.checks || []).filter((x) => x[0] !== today);
    h.checks.push([today, stats.ok, stats.items]);
  }
  h.updated = today;
  // одна модель — одна строка: файл компактный, а изменения в истории коммитов видны построчно
  const lines = Object.entries(h.items).map(([id, rec]) => `  ${JSON.stringify(id)}: ${JSON.stringify(rec)}`);
  fs.writeFileSync(JSON_FILE, `{\n "start": ${JSON.stringify(h.start)},\n "updated": ${JSON.stringify(h.updated)},\n "checks": ${JSON.stringify(h.checks)},\n "items": {\n${lines.join(',\n')}\n }\n}\n`);
  writeCsv(h, data);
}

function writeCsv(h, data) {
  const comp = Object.fromEntries(data.competitors.map((c) => [c.id, c]));
  const cls = Object.fromEntries(data.classes.map((c) => [c.id, c.name]));
  const rows = [];
  for (const [id, rec] of Object.entries(h.items)) {
    for (let i = 1; i < rec.p.length; i++) {
      const [date, to] = rec.p[i], from = rec.p[i - 1][1];
      rows.push([date, comp[rec.c]?.name || rec.c, rec.model, cls[rec.cls] || rec.cls, from, to, to - from, ((to - from) / from * 100).toFixed(1).replace('.', ','), comp[rec.c]?.vat_excl ? 'без НДС' : '', rec.url || '']);
    }
  }
  rows.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
  const head = ['Дата', 'Компания', 'Модель', 'Класс', 'Было, ₽', 'Стало, ₽', 'Разница, ₽', 'Изменение, %', 'Цена на сайте', 'Страница'];
  const q = (v) => (/[;"\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  fs.writeFileSync(CSV_FILE, '﻿' + [head, ...rows].map((r) => r.map(q).join(';')).join('\r\n') + '\r\n');
}

// Страницы сайтов, которые пускают не все машины GitHub.
// Часть адресов GitHub (в нашей проверке все из сети 20.x) эти сайты не пускают: соединение висит до таймаута.
// Задача dealers в workflow запускает этот файл на нескольких машинах по очереди, пока одна не скачает всё.
// Результат — pages/pages.json, его подхватывает update.mjs.
//   node pages.mjs
import fs from 'node:fs';
import { fetchText } from './lib.mjs';

export const PICKY = ['tuttiho.ru', 'acousticmos.ru'];

const data = JSON.parse(fs.readFileSync(new URL('./prices.json', import.meta.url), 'utf8'));
const host = (u) => new URL(u).hostname.replace(/^www\./, '');
const urls = [...new Set(data.items.map((i) => i.url))].filter((u) => PICKY.includes(host(u)));
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const out = {};
let blocked = false;
for (const u of urls) {
  const r = await fetchText(u, { raw: true, timeoutMs: 15000 });
  if (r.reason === 'fetch_failed') {
    console.log(`✗ ${u} — ${r.error || r.reason}`);
    blocked = true;
    break;
  }
  out[u] = r;
  await sleep(2000);
}

const ok = !blocked && urls.length > 0;
if (ok) {
  fs.mkdirSync('pages', { recursive: true });
  fs.writeFileSync('pages/pages.json', JSON.stringify(out));
}
console.log(ok ? `Скачано страниц: ${Object.keys(out).length}` : 'С этой машины сайты не открываются');
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `ok=${ok}\n`);

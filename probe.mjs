// Пускают ли сайты эту машину GitHub.
// Часть адресов GitHub некоторые сайты не пускают: соединение висит до таймаута или сразу 403.
// Workflow берёт машины по очереди и обновляет цены на первой, где эта проверка прошла.
//   node probe.mjs
import fs from 'node:fs';
import { fetchText } from './lib.mjs';

const PICKY = ['tuttiho.ru', 'acousticmos.ru', 'lwop.ru'];

const data = JSON.parse(fs.readFileSync(new URL('./prices.json', import.meta.url), 'utf8'));
const host = (u) => new URL(u).hostname.replace(/^www\./, '');
let ok = true;
for (const h of PICKY) {
  const u = data.items.map((i) => i.url).find((x) => host(x) === h);
  if (!u) continue;
  const r = await fetchText(u, { timeoutMs: 15000 });
  console.log(`${h}: ${r.ok ? 'открылся' : r.reason + (r.error ? ' (' + r.error + ')' : '')}`);
  if (!r.ok) ok = false;
}
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `ok=${ok}\n`);

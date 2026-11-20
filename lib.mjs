// Общие функции: скачивание страницы, превращение HTML в текст и поиск цены рядом с названием модели.
// Работает в Node 20+ без внешних библиотек (одна и та же логика используется и в браузере).

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const ENT = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', laquo: '«', raquo: '»', ndash: '–', mdash: '—', rub: '₽', thinsp: ' ', ensp: ' ', emsp: ' ', times: '×' };

export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENT ? ENT[n.toLowerCase()] : m));
}

// HTML → плоский текст. Скрипты и стили выкидываем, но JSON внутри <script> (каталоги Тильды и т.п.)
// можно оставить флагом keepScripts — тогда цена ищется и в данных страницы.
export function htmlToText(html, { keepScripts = false } = {}) {
  let s = html;
  if (!keepScripts) s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(p|div|li|tr|td|th|h\d|section|article|ul|ol|table|header|footer|nav|button|label)\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  // « | » — граница блока: через неё цена не «склеивается» с соседними числами (счётчики, артикулы)
  return s
    .replace(/[\s\u00a0\u202f\u2009\u2007]+/g, ' ')
    .replace(/( ?\| ?)+/g, ' | ')
    .trim();
}

// Поиск якоря без учёта границ блоков и лишних пробелов: «Base One 1 человек» найдётся и в «base one | 1 человек»
function anchorRegex(anchor) {
  const words = norm(anchor).split(' ').filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(words.join('(?: ?\\| ?| )*'), 'g');
}

// Цена: «325 000 р.», «от 295 000 ₽», «1 050 000 руб», «550,000 ₽», "price":"295000"
// текст перед поиском приводится к нижнему регистру, поэтому «Р»/«P» (кириллица и латиница) ловим как «р»/«p»
const PRICE_RE = /(?<![\d])(\d{1,3}(?:[ .,]\d{3})+|\d{5,8})(?:[.,]\d{1,2})?\s*(?:\|\s*)?(?:₽|руб(?:л[а-я]*)?(?![а-я])|р\.|р(?=[\s.,|]|$)|p(?=[\s.,|]|$)|rub)/g;
const JSON_PRICE_RE = /"price"\s*:\s*"?(\d{4,8})(?:\.\d+)?"?/g;

export function toNumber(s) {
  const n = Number(String(s).replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function norm(s) {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[\s ]+/g, ' ');
}

/**
 * Ищет цену после якоря (название модели или уникальный кусок текста перед ценой).
 * opts.nth — какая по счёту цена после якоря (1 = первая), opts.maxDist — сколько символов можно пройти,
 * opts.anchorNth — какое по счёту вхождение якоря брать, opts.json — искать "price": в данных,
 * opts.min/opts.max — разумные границы (чтобы не схватить цену доставки или опции).
 */
export function findPrice(text, anchor, opts = {}) {
  const { nth = 1, maxDist = 700, anchorNth = 1, json = false, min = 30000, max = 15000000, before = false } = opts;
  const t = norm(text);
  let pos = -1;
  if (anchor) {
    const re = anchorRegex(anchor);
    let m = null;
    for (let i = 0; i < anchorNth; i++) {
      m = re.exec(t);
      if (!m) return { ok: false, reason: 'anchor_not_found' };
    }
    pos = before ? m.index : m.index + m[0].length;
  } else pos = 0;
  const windowText = before ? t.slice(Math.max(0, pos - maxDist), pos) : t.slice(pos, pos + maxDist);
  const re = new RegExp((json ? JSON_PRICE_RE : PRICE_RE).source, 'g');
  const found = [];
  let m;
  while ((m = re.exec(windowText))) {
    const v = toNumber(m[1]);
    if (v != null && v >= min && v <= max) found.push({ v, at: m.index, raw: m[0] });
  }
  if (before) found.reverse();
  const hit = found[nth - 1];
  if (!hit) return { ok: false, reason: 'price_not_found' };
  const ctx = windowText.slice(Math.max(0, hit.at - 60), hit.at + hit.raw.length + 5);
  return { ok: true, price: hit.v, context: ctx };
}

// Цена из структурированных данных карточки товара: JSON-LD offers.price, itemprop="price", product:price:amount
export function structuredPrice(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const stack = [JSON.parse(m[1].trim())];
      while (stack.length) {
        const x = stack.pop();
        if (Array.isArray(x)) stack.push(...x);
        else if (x && typeof x === 'object') {
          if (x.offers) {
            const o = Array.isArray(x.offers) ? x.offers[0] : x.offers;
            const p = o && (o.price ?? o.lowPrice);
            if (p) out.push(Math.round(parseFloat(String(p).replace(',', '.'))));
          }
          for (const v of Object.values(x)) if (v && typeof v === 'object') stack.push(v);
        }
      }
    } catch {}
  }
  if (out.length) return { price: out[0], how: 'jsonld' };
  const ip =
    html.match(/itemprop=["']price["'][^>]*content=["']([\d\s.,]+)["']/i) ||
    html.match(/content=["']([\d\s.,]+)["'][^>]*itemprop=["']price["']/i) ||
    html.match(/itemprop=["']price["'][^>]*>\s*([\d\s .,]+?)\s*</i);
  if (ip) {
    const v = toNumber(ip[1].split(/[.,]\d{2}$/)[0]);
    if (v > 1000) return { price: v, how: 'itemprop' };
  }
  const og = html.match(/property=["']product:price:amount["'][^>]*content=["']([\d.]+)["']/i);
  if (og) return { price: Math.round(+og[1]), how: 'og' };
  return null;
}

export async function fetchText(url, { timeoutMs = 25000, raw = false, keepScripts = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9', Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const body = await r.text();
    if (!r.ok) return { ok: false, status: r.status, reason: 'http_' + r.status };
    return { ok: true, status: r.status, text: raw ? body : htmlToText(body, { keepScripts }) };
  } catch (e) {
    return { ok: false, reason: 'fetch_failed', error: e.name === 'AbortError' ? 'timeout' : String(e.cause?.code || e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

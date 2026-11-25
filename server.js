'use strict';
/*
  Terminal graphique – serveur (aucune dépendance, Node >= 18)
  Sert index.html et relaie Yahoo Finance (le navigateur ne peut pas l'appeler directement : CORS).

  Lancer :   node server.js          puis ouvrir http://localhost:3000
  Héberger : Render / Railway / Fly.io / VPS → commande de démarrage « npm start » (ou « node server.js »).
  Variables optionnelles : PORT (3000), YAHOO_BASE (pour tests), RATE_LIMIT (requêtes/min/IP, 300).
*/
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 3000;
const RATE = +process.env.RATE_LIMIT || 300;
const INDEX = process.env.INDEX_FILE || path.join(__dirname, 'index.html');
const BASES = process.env.YAHOO_BASE ? [process.env.YAHOO_BASE.replace(/\/$/, '')]
  : ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* intervalle Yahoo, historique complet (r), historique pour la mise à jour temps réel (lr), agrégation (secondes) */
const TFC = {
  '1 min': { i: '1m', r: '7d', lr: '1d' },
  '5 min': { i: '5m', r: '60d', lr: '1d' },
  '15 min': { i: '15m', r: '60d', lr: '5d' },
  '30 min': { i: '30m', r: '60d', lr: '5d' },
  '1 h': { i: '60m', r: '6mo', lr: '5d' },
  '4 h': { i: '60m', r: '1y', lr: '5d', agg: 14400 },
  '1 j': { i: '1d', r: '5y', lr: '5d' },
  '1 sem': { i: '1wk', r: '10y', lr: '1mo' }
};

class HttpErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }

/* ---------- cache (partage aussi les requêtes simultanées) ---------- */
const cache = new Map();
function cached(key, ttl, fn) {
  const now = Date.now(), c = cache.get(key);
  if (c && c.exp > now) return c.p;
  const p = fn();
  cache.set(key, { exp: now + ttl, p });
  p.catch(() => cache.delete(key));
  if (cache.size > 3000) for (const [k, v] of cache) if (v.exp < now) cache.delete(k);
  return p;
}

/* ---------- Yahoo ---------- */
async function yf(pq) {
  let last = null;
  for (const b of BASES) {
    try {
      const r = await fetch(b + pq, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (r.status === 404) throw new HttpErr(404, 'Symbole introuvable chez Yahoo Finance');
      if (r.status === 429) { last = new HttpErr(429, 'Limite Yahoo Finance atteinte, réessayez dans un instant'); continue; }
      if (!r.ok) { last = new HttpErr(502, 'Yahoo Finance a répondu ' + r.status); continue; }
      return await r.json();
    } catch (e) {
      if (e instanceof HttpErr && e.code === 404) throw e;
      last = e instanceof HttpErr ? e : new HttpErr(502, 'Yahoo Finance injoignable');
    }
  }
  throw last || new HttpErr(502, 'Yahoo Finance injoignable');
}

function parseChart(j) {
  const c = j && j.chart;
  if (c && c.error) throw new HttpErr(404, c.error.description || 'Symbole introuvable');
  const r = c && c.result && c.result[0];
  if (!r) throw new HttpErr(502, 'Réponse Yahoo vide');
  const ts = r.timestamp || [], q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open && q.open[i], h = q.high && q.high[i], l = q.low && q.low[i], cl = q.close && q.close[i];
    if ([o, h, l, cl].some(v => v == null || !isFinite(v))) continue;
    bars.push([ts[i], o, h, l, cl, (q.volume && q.volume[i]) || 0]);
  }
  return { meta: r.meta || {}, bars };
}

function aggregate(bars, sec) {
  const out = []; let cur = null;
  for (const b of bars) {
    const k = Math.floor(b[0] / sec) * sec;
    if (!cur || cur[0] !== k) { if (cur) out.push(cur); cur = [k, b[1], b[2], b[3], b[4], b[5]]; }
    else { cur[2] = Math.max(cur[2], b[2]); cur[3] = Math.min(cur[3], b[3]); cur[4] = b[4]; cur[5] += b[5]; }
  }
  if (cur) out.push(cur);
  return out;
}

function decimals(sym, price, hint) {
  if (sym.endsWith('=X') && price < 20) return 5;
  if (Number.isFinite(hint)) return hint;
  return price >= 100 ? 2 : price >= 10 ? 3 : 4;
}

function getChart(sym, tf, live) {
  const cfg = TFC[tf];
  const ttl = live ? 3000 : 20000;
  return cached('c:' + sym + '|' + tf + '|' + (live ? 1 : 0), ttl, async () => {
    const j = await yf('/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=' + cfg.i + '&range=' + (live ? cfg.lr : cfg.r) + '&includePrePost=false');
    const { meta, bars } = parseChart(j);
    const out = cfg.agg ? aggregate(bars, cfg.agg) : bars;
    const last = out.length ? out[out.length - 1][4] : meta.regularMarketPrice;
    return {
      symbol: meta.symbol || sym, tf, live: !!live,
      meta: { name: meta.shortName || meta.longName || '', cur: meta.currency || '', exch: meta.exchangeName || '', dec: decimals(sym, last || 1, meta.priceHint), price: meta.regularMarketPrice },
      bars: out
    };
  });
}

function getQuote(sym) {
  return cached('q:' + sym, 10000, async () => {
    const j = await yf('/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=5d&includePrePost=false');
    const { meta, bars } = parseChart(j);
    const lastBar = bars.length ? bars[bars.length - 1][4] : null;
    const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : lastBar;
    if (price == null) throw new HttpErr(404, 'Pas de cotation');
    const prev = bars.length >= 2 ? bars[bars.length - 2][4] : (meta.chartPreviousClose != null ? meta.chartPreviousClose : null);
    const chg = prev != null ? price - prev : 0;
    return { symbol: sym, name: meta.shortName || meta.longName || '', cur: meta.currency || '', price, prev, chg, pct: prev ? chg / prev * 100 : 0, dec: decimals(sym, price, meta.priceHint) };
  });
}

function search(q) {
  return cached('s:' + q.toLowerCase(), 60000, async () => {
    const j = await yf('/v1/finance/search?q=' + encodeURIComponent(q) + '&quotesCount=12&newsCount=0&listsCount=0');
    const res = [], seen = new Set();
    const fx = q.match(/^\s*([A-Za-z]{3})\s*\/\s*([A-Za-z]{3})\s*$/);
    if (fx) { const s = (fx[1] + fx[2]).toUpperCase() + '=X'; seen.add(s); res.push({ symbol: s, name: fx[1].toUpperCase() + '/' + fx[2].toUpperCase(), exch: 'Forex', type: 'Devise' }); }
    for (const x of (j.quotes || [])) {
      if (!x.symbol || seen.has(x.symbol)) continue;
      seen.add(x.symbol);
      res.push({ symbol: x.symbol, name: x.shortname || x.longname || '', exch: x.exchDisp || '', type: x.typeDisp || '' });
    }
    return { results: res };
  });
}

/* ---------- HTTP ---------- */
const hits = new Map();
function limited(ip) {
  const now = Date.now(); let h = hits.get(ip);
  if (!h || now - h.t > 60000) { h = { t: now, n: 0 }; hits.set(ip, h); }
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.t > 60000) hits.delete(k);
  return ++h.n > RATE;
}
const SYM = /^[A-Za-z0-9^=.\-_]{1,24}$/;
function send(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(b);
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(INDEX).on('error', () => { res.writeHead(500); res.end('index.html introuvable'); }).pipe(res);
    }
    if (!p.startsWith('/api/')) { res.writeHead(404); return res.end('Not found'); }
    const ip = ((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();
    if (limited(ip)) return send(res, 429, { error: 'Trop de requêtes, patientez une minute' });

    if (p === '/api/health') return send(res, 200, { ok: true });
    if (p === '/api/chart') {
      const s = u.searchParams.get('symbol') || '', tf = u.searchParams.get('tf') || '1 h';
      if (!SYM.test(s)) return send(res, 400, { error: 'Symbole invalide' });
      if (!TFC[tf]) return send(res, 400, { error: 'Intervalle invalide' });
      return send(res, 200, await getChart(s, tf, u.searchParams.get('live') === '1'));
    }
    if (p === '/api/quotes') {
      const list = (u.searchParams.get('symbols') || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 40);
      if (!list.length || list.some(x => !SYM.test(x))) return send(res, 400, { error: 'Symboles invalides' });
      const quotes = [], errors = [];
      for (let i = 0; i < list.length; i += 6) {
        const r = await Promise.allSettled(list.slice(i, i + 6).map(getQuote));
        r.forEach((x, k) => x.status === 'fulfilled' ? quotes.push(x.value) : errors.push({ symbol: list[i + k], error: x.reason.message }));
      }
      return send(res, 200, { quotes, errors });
    }
    if (p === '/api/search') {
      const q = (u.searchParams.get('q') || '').trim().slice(0, 40);
      if (!q) return send(res, 200, { results: [] });
      return send(res, 200, await search(q));
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message || 'Erreur serveur' });
  }
}).listen(PORT, () => console.log('Terminal graphique : http://localhost:' + PORT));

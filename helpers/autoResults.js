const {
  getMarkets,
  saveMarkets,
  getAutoResultSettings,
  saveAutoResultSettings,
  getAutoResultState,
  saveAutoResultState
} = require('./data');
const { saveDailyResult } = require('./results');

let timer = null;
let running = false;

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\bpool\b/g, '')
    .replace(/4d/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function normalizeBaseUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('URL sumber belum diisi.');
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new Error('URL sumber tidak valid. Gunakan http:// atau https://');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('URL sumber harus menggunakan HTTP/HTTPS.');
  }
  return `${url.protocol}//${url.host}`;
}

function parsePoolOptions(html) {
  const out = [];
  const re = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let match;
  while ((match = re.exec(String(html || '')))) {
    const attrs = match[1] || '';
    const codeMatch = attrs.match(/data-code\s*=\s*["']([^"']+)["']/i);
    if (!codeMatch) continue;
    const nameMatch = attrs.match(/data-name\s*=\s*["']([^"']+)["']/i);
    const text = cleanText(match[2]);
    const name = cleanText(nameMatch ? nameMatch[1] : text);
    const code = cleanText(codeMatch[1]);
    if (name && code) out.push({ name, code });
  }
  return out;
}

function parseResultRows(html) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(String(html || '')))) {
    const cells = [];
    const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let td;
    while ((td = tdRe.exec(tr[1]))) cells.push(cleanText(td[1]));
    if (cells.length < 3) continue;

    const period = String(cells[0] || '').replace(/[^0-9]/g, '');
    const dateRaw = String(cells[1] || '').trim();
    const number = String(cells[2] || '').replace(/\D/g, '').slice(0, 5);
    if (!period || !number) continue;

    const dateMatch = dateRaw.match(/(\d{4}-\d{2}-\d{2})/);
    const timeMatch = dateRaw.match(/(\d{2}:\d{2})(?::\d{2})?/);
    rows.push({
      period,
      date: dateMatch ? dateMatch[1] : null,
      resultTime: timeMatch ? timeMatch[1] : null,
      prize1: number,
      rawDate: dateRaw
    });
  }
  return rows;
}

function selectLatestRow(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return [...rows].sort((a, b) => {
    const ai = Number(a.period);
    const bi = Number(b.period);
    if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return bi - ai;
    if (a.date && b.date && a.date !== b.date) return String(b.date).localeCompare(String(a.date));
    return 0;
  })[0];
}

async function fetchText(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; ResultMonitor/1.0)',
        'accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'cache-control': 'no-cache'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} dari sumber`);
    return await response.text();
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('Timeout saat mengambil sumber result.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function detectMarketCodes({ persist = true } = {}) {
  const settings = getAutoResultSettings();
  const base = normalizeBaseUrl(settings.sourceUrl);
  const sourceUrl = new URL(settings.sourceUrl, `${base}/`).toString();
  const html = await fetchText(sourceUrl, Number(settings.timeoutMs) || 12000);
  const options = parsePoolOptions(html);
  if (!options.length) throw new Error('Kode pasaran tidak ditemukan pada halaman sumber.');

  const markets = getMarkets();
  let changed = 0;
  const mapping = [];

  for (const market of markets) {
    const wanted = normalizeName(market.name);
    const byExisting = market.sourceCode
      ? options.find((item) => String(item.code) === String(market.sourceCode))
      : null;
    const byExact = options.find((item) => normalizeName(item.name) === wanted);
    const byLoose = options.find((item) => {
      const n = normalizeName(item.name);
      return n && wanted && (n.includes(wanted) || wanted.includes(n));
    });
    const found = byExisting || byExact || byLoose || null;
    if (found && market.sourceCode !== found.code) {
      market.sourceCode = found.code;
      changed += 1;
    }
    mapping.push({
      slug: market.slug,
      market: market.name,
      sourceCode: found ? found.code : (market.sourceCode || ''),
      sourceName: found ? found.name : '',
      matched: !!found
    });
  }

  if (persist && changed) saveMarkets(markets);
  return { found: options.length, changed, mapping };
}

function comparePeriods(next, previous) {
  if (!previous) return 1;
  const a = Number(next);
  const b = Number(previous);
  if (Number.isFinite(a) && Number.isFinite(b)) return a === b ? 0 : (a > b ? 1 : -1);
  return String(next).localeCompare(String(previous));
}

async function scanMarket(market, settings, state, { force = false } = {}) {
  if (market.autoResultEnabled === false) {
    return { market: market.name, slug: market.slug, status: 'disabled' };
  }
  if (!market.sourceCode) {
    return { market: market.name, slug: market.slug, status: 'no_code', error: 'Kode sumber belum diatur.' };
  }

  const base = normalizeBaseUrl(settings.sourceUrl);
  const endpointTemplate = String(settings.resultPathTemplate || '/history/result/{code}/kosong');
  const path = endpointTemplate.replace('{code}', encodeURIComponent(market.sourceCode));
  const endpoint = new URL(path, `${base}/`).toString();
  const html = await fetchText(endpoint, Number(settings.timeoutMs) || 12000);
  const latest = selectLatestRow(parseResultRows(html));
  if (!latest) throw new Error(`Result ${market.name} tidak ditemukan di sumber.`);

  const prev = state.markets[market.slug] || {};
  const cmp = comparePeriods(latest.period, prev.period);
  if (!force && prev.period && cmp <= 0) {
    return { market: market.name, slug: market.slug, status: 'unchanged', latest, endpoint };
  }

  // First discovery is baseline by default, to avoid blasting old data after a fresh deploy.
  if (!force && !prev.period && settings.sendFirstSeen === false) {
    state.markets[market.slug] = {
      period: latest.period,
      prize1: latest.prize1,
      date: latest.date,
      seenAt: new Date().toISOString()
    };
    return { market: market.name, slug: market.slug, status: 'baselined', latest, endpoint };
  }

  const saved = saveDailyResult(market.slug, {
    date: latest.date || undefined,
    prize1: latest.prize1,
    resultTime: latest.resultTime || market.resultTime || '00:00',
    period: latest.period,
    source: 'auto',
    sourceCode: market.sourceCode
  });

  state.markets[market.slug] = {
    period: latest.period,
    prize1: latest.prize1,
    date: saved.date,
    seenAt: new Date().toISOString()
  };

  return { market: market.name, slug: market.slug, status: 'updated', latest, saved, endpoint };
}

async function scanOnce({ force = false, autoDetect = true } = {}) {
  if (running) return { ok: false, busy: true, results: [] };
  running = true;
  const startedAt = new Date().toISOString();
  try {
    let settings = getAutoResultSettings();
    if (!settings.sourceUrl) throw new Error('URL sumber result belum diisi.');

    if (autoDetect && settings.autoDetectCodes !== false) {
      const missingCode = getMarkets().some((m) => !m.sourceCode);
      if (missingCode) {
        try { await detectMarketCodes({ persist: true }); } catch (error) {
          console.error('[AutoResult] auto detect code failed:', error.message);
        }
      }
    }

    settings = getAutoResultSettings();
    const state = getAutoResultState();
    state.markets = state.markets && typeof state.markets === 'object' ? state.markets : {};
    const results = [];

    for (const market of getMarkets()) {
      try {
        const result = await scanMarket(market, settings, state, { force });
        results.push(result);
      } catch (error) {
        results.push({ market: market.name, slug: market.slug, status: 'error', error: error.message });
      }
    }

    state.lastScanAt = new Date().toISOString();
    state.lastScanStartedAt = startedAt;
    state.lastScanOk = results.every((r) => r.status !== 'error');
    state.lastResults = results.slice(-100);
    saveAutoResultState(state);
    return { ok: state.lastScanOk, busy: false, results, lastScanAt: state.lastScanAt };
  } finally {
    running = false;
  }
}

function stopAutoResultWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

function startAutoResultWorker() {
  stopAutoResultWorker();
  const settings = getAutoResultSettings();
  const seconds = Math.max(10, Math.min(3600, Number(settings.scanIntervalSeconds) || 20));
  timer = setInterval(async () => {
    const current = getAutoResultSettings();
    if (current.enabled !== true) return;
    try {
      await scanOnce({ force: false, autoDetect: true });
    } catch (error) {
      const state = getAutoResultState();
      state.lastScanAt = new Date().toISOString();
      state.lastScanOk = false;
      state.lastError = error.message;
      saveAutoResultState(state);
      console.error('[AutoResult] scan failed:', error.message);
    }
  }, seconds * 1000);
  if (timer.unref) timer.unref();
  console.log(`[AutoResult] worker ready, interval ${seconds}s`);
}

function restartAutoResultWorker() {
  startAutoResultWorker();
}

module.exports = {
  cleanText,
  normalizeName,
  normalizeBaseUrl,
  parsePoolOptions,
  parseResultRows,
  selectLatestRow,
  detectMarketCodes,
  scanOnce,
  startAutoResultWorker,
  stopAutoResultWorker,
  restartAutoResultWorker
};

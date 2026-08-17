const {
  getMarkets,
  saveMarkets,
  getAutoResultSettings,
  getAutoResultState,
  saveAutoResultState
} = require('./data');
const { saveDailyResult } = require('./results');

let timer = null;
let running = false;

function cleanText(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\bpool\b/g, '')
    .replace(/\b4d\b/g, '')
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
  const seen = new Set();
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
    const key = `${code}::${normalizeName(name)}`;
    if (name && code && !seen.has(key)) {
      seen.add(key);
      out.push({ name, code });
    }
  }
  return out;
}

function parseCells(rowHtml, tagName) {
  const cells = [];
  const re = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  let m;
  while ((m = re.exec(String(rowHtml || '')))) {
    const attrs = m[1] || '';
    const text = cleanText(m[2]);
    const classMatch = attrs.match(/class\s*=\s*["']([^"']*)["']/i);
    cells.push({
      attrs,
      text,
      className: classMatch ? classMatch[1] : ''
    });
  }
  return cells;
}

function normalizeHeader(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function headerIndex(headers, patterns) {
  return headers.findIndex((h) => patterns.some((p) => p.test(normalizeHeader(h))));
}

function parseOneResultTable(tableHtml) {
  const html = String(tableHtml || '');
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const rawRows = [];
  let m;
  let headers = [];

  while ((m = rowRe.exec(html))) {
    const th = parseCells(m[1], 'th');
    if (th.length && !headers.length) headers = th.map((c) => c.text);
    const td = parseCells(m[1], 'td');
    if (td.length) rawRows.push(td);
  }

  const periodIndex = Math.max(0, headerIndex(headers, [/^periode?$/, /^period$/]));
  const dateIndexFromHeader = headerIndex(headers, [/^tanggal$/, /^date$/, /^datetime$/, /^waktu$/]);

  // Prize 1 MUST be read from the first result column only. Some source pages
  // expose three result columns: Nomor | Nomor 2 | Nomor 3 (Prize 1/2/3).
  // Never fall through to Nomor 2/Nomor 3 just because they also contain 4 digits.
  const prize1Index = headerIndex(headers, [
    /^nomor$/, /^nomor1$/, /^number$/, /^number1$/, /^result$/, /^result1$/,
    /^hasil$/, /^hasil1$/, /^prize$/, /^prize1$/, /^1stprize$/, /^angka$/, /^angka1$/
  ]);
  const prize2Index = headerIndex(headers, [/^nomor2$/, /^number2$/, /^result2$/, /^hasil2$/, /^prize2$/, /^2ndprize$/, /^angka2$/]);
  const prize3Index = headerIndex(headers, [/^nomor3$/, /^number3$/, /^result3$/, /^hasil3$/, /^prize3$/, /^3rdprize$/, /^angka3$/]);
  const hasRecognizedHeader = headers.length > 0 && headerIndex(headers, [/^periode?$/, /^period$/]) >= 0;
  const hasPrize1Header = prize1Index >= 0;
  const hasAnyPrizeHeader = prize1Index >= 0 || prize2Index >= 0 || prize3Index >= 0;
  const rows = [];

  for (const cells of rawRows) {
    if (cells.length < 3) continue;

    const periodCell = cells[periodIndex] || cells[0];
    const periodMatch = String(periodCell.text || '').trim().match(/^\d+$/);
    if (!periodMatch) continue;

    let numberCell = null;
    if (hasPrize1Header && cells[prize1Index]) {
      numberCell = cells[prize1Index];
    } else if (hasAnyPrizeHeader) {
      // A table that advertises Prize/Nomor 2 or 3 but has no Prize/Nomor 1 is
      // ambiguous. Reject it instead of accidentally publishing Prize 2/3.
      continue;
    } else {
      numberCell = cells.find((c) => /(?:^|\s)nomor-history(?:\s|$)/i.test(c.className));
    }
    if (!numberCell) {
      // Legacy 3-column pages have no header/class. Only allow the final-cell
      // fallback when there is no multi-prize header at all.
      numberCell = cells[cells.length - 1];
    }

    // IMPORTANT: never strip punctuation from a candidate result. Doing so turned
    // "2026-08-17" into the fake result "20260" in the previous build.
    const numberText = String(numberCell.text || '').trim();
    if (!/^\d{4,5}$/.test(numberText)) continue;

    let dateCell = null;
    if (dateIndexFromHeader >= 0 && cells[dateIndexFromHeader]) {
      dateCell = cells[dateIndexFromHeader];
    } else {
      dateCell = cells.find((c, index) => index !== periodIndex && index !== cells.indexOf(numberCell) && /\d{4}-\d{2}-\d{2}/.test(c.text));
    }
    const dateRaw = dateCell ? String(dateCell.text || '').trim() : '';
    const dateMatch = dateRaw.match(/(\d{4}-\d{2}-\d{2})/);
    const timeMatch = dateRaw.match(/(?:^|\s)(\d{2}:\d{2})(?::\d{2})?(?:\s|$)/);

    rows.push({
      period: periodMatch[0],
      date: dateMatch ? dateMatch[1] : null,
      resultTime: timeMatch ? timeMatch[1] : null,
      prize1: numberText,
      rawDate: dateRaw,
      _parser: hasPrize1Header ? 'prize1-header' : (hasRecognizedHeader ? 'header' : (/nomor-history/i.test(numberCell.className) ? 'class' : 'last-cell'))
    });
  }

  return rows;
}

function parseResultRows(html) {
  const source = String(html || '');
  const tables = [];
  const tableRe = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
  let m;
  while ((m = tableRe.exec(source))) tables.push(m[0]);

  if (tables.length) {
    // Prefer a table explicitly labeled Periode + Nomor. This prevents unrelated
    // tables from being interpreted as lottery results when a full page is returned.
    const scored = tables.map((table) => {
      const th = [];
      const thRe = /<th\b[^>]*>([\s\S]*?)<\/th>/gi;
      let hm;
      while ((hm = thRe.exec(table))) th.push(normalizeName(cleanText(hm[1])));
      let score = 0;
      if (th.includes('periode') || th.includes('period')) score += 2;
      if (th.includes('nomor') || th.includes('nomor1') || th.includes('number') || th.includes('number1') || th.includes('result') || th.includes('result1') || th.includes('hasil') || th.includes('hasil1') || th.includes('prize1')) score += 3;
      if (th.includes('tanggal') || th.includes('date')) score += 1;
      return { table, score };
    }).sort((a, b) => b.score - a.score);

    for (const item of scored) {
      const rows = parseOneResultTable(item.table);
      if (rows.length) return rows;
    }
    return [];
  }

  return parseOneResultTable(source);
}

function selectLatestRow(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return [...rows].sort((a, b) => {
    const ai = Number(a.period);
    const bi = Number(b.period);
    if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return bi - ai;
    const ad = `${a.date || ''} ${a.resultTime || ''}`;
    const bd = `${b.date || ''} ${b.resultTime || ''}`;
    return bd.localeCompare(ad);
  })[0];
}

const EXPLICIT_NAME_ALIASES = {
  singapore: ['singapura'],
  singapura: ['singapore'],
  srilanka: ['srilanka'],
  californiatoday: ['california'],
  carolinaday: ['carolinaday'],
  carolinaeve: ['carolinaeve'],
  floridamid: ['floridamid'],
  floridaeve: ['floridaeve'],
  newyorkmid: ['newyorkmid'],
  newyorkeve: ['newyorkeve'],
  kentuckymid: ['kentuckymid'],
  kentuckyeve: ['kentuckyeve'],
  jowo09: ['jowo0900'],
  jowo21: ['jowo2100'],
  jakarta14: ['jakarta1400'],
  jakarta23: ['jakarta2330'],
  totomali1530: ['totomali1530'],
  totomali2030: ['totomali2030'],
  totomali2330: ['totomali2330'],

  // Nama lokal dan nama pool sumber tidak selalu identik.
  // Alias ini sengaja eksplisit agar tidak salah mengambil pool lain yang
  // kebetulan mirip. Sesuai mapping operasional: OREGON3 -> OREGON09.
  oregon3: ['oregon09'],
  oregon03local: ['oregon09'],

  // TOTO MACAU 5D pada daftar lokal menggunakan nama yang berbeda dari
  // sumber. Di halaman sumber pool resminya bernama "TOTO MACAO 5D"
  // (normalisasi: totomacao5d). Mapping dibuat eksplisit supaya varian 5D
  // tidak pernah jatuh ke pool TOTO MACAU biasa (m17).
  totomacau5d: ['totomacao5d'],
  totomacao5d: ['totomacau5d']
};

function splitAlphaNumericName(value) {
  const normalized = normalizeName(value);
  const m = normalized.match(/^([a-z]+)(\d+)$/);
  if (!m) return null;
  return { base: m[1], digits: m[2] };
}

function addSafeFormattingAliases(out, wanted) {
  const parts = splitAlphaNumericName(wanted);
  if (!parts) return;

  // Safe formatting variants only: OREGON09 <-> OREGON9 and
  // JAKARTA1400 <-> JAKARTA14 are accepted without fuzzy guessing.
  const number = Number(parts.digits);
  if (!Number.isFinite(number)) return;
  out.add(`${parts.base}${number}`);
  if (parts.digits.length === 1) out.add(`${parts.base}0${parts.digits}`);

  if (parts.digits.endsWith('00') && parts.digits.length >= 4) {
    out.add(`${parts.base}${parts.digits.slice(0, -2)}`);
  }
}

function deriveNameCandidates(marketName) {
  const wanted = normalizeName(marketName);
  const out = new Set([wanted]);
  (EXPLICIT_NAME_ALIASES[wanted] || []).forEach((x) => out.add(normalizeName(x)));
  addSafeFormattingAliases(out, wanted);

  // TOTO MACAU regular and TOTO MACAO 5D are DIFFERENT source pools.
  // Regular draw slots map to source "TOTO MACAU". Any local 5D slot/name
  // maps only to source "TOTO MACAO 5D" so it cannot accidentally use m17.
  if (/^totomacau\d{2}5d$/.test(wanted) || wanted === 'totomacau5d') {
    out.add('totomacao5d');
  } else if (/^totomacau\d{2}$/.test(wanted)) {
    out.add('totomacau');
  }
  if (/^kingkong\d+$/.test(wanted)) out.add('kingkong');
  return [...out].filter(Boolean);
}

function scoreSourceNameMatch(marketName, sourceName) {
  const candidates = deriveNameCandidates(marketName);
  const source = normalizeName(sourceName);
  const exactIndex = candidates.indexOf(source);
  if (exactIndex >= 0) return { score: 1000 - exactIndex, reason: exactIndex === 0 ? 'exact' : 'alias' };

  const wanted = splitAlphaNumericName(marketName);
  const offered = splitAlphaNumericName(sourceName);
  if (!wanted || !offered || wanted.base !== offered.base) return { score: 0, reason: 'none' };

  // Never guess between several numbered pools (OREGON03/06/09/12, etc.).
  // A wrong result is worse than an unmatched mapping. Numbered mismatches
  // must be covered by an explicit alias above or configured manually.
  return { score: 0, reason: 'number-mismatch' };
}

function deriveTargetHour(market) {
  if (market && market.sourceResultHour !== undefined && market.sourceResultHour !== null && String(market.sourceResultHour).trim() !== '') {
    const h = Number(market.sourceResultHour);
    if (Number.isInteger(h) && h >= 0 && h <= 23) return h;
  }
  const n = normalizeName(market && market.name);
  let match = n.match(/^totomacau(\d{2})(?:5d)?$/);
  if (match) return Number(match[1]);
  match = n.match(/^kingkong(\d{2})$/);
  if (match) return Number(match[1]);
  return null;
}

function selectRowForMarket(rows, market) {
  const targetHour = deriveTargetHour(market);
  if (targetHour === null) return selectLatestRow(rows);
  const matching = rows.filter((row) => {
    if (!row.resultTime || !/^\d{2}:\d{2}$/.test(row.resultTime)) return false;
    return Number(row.resultTime.slice(0, 2)) === targetHour;
  });
  return selectLatestRow(matching);
}

async function fetchText(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; ResultMonitor/2.0)',
        'accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'cache-control': 'no-cache, no-store',
        'pragma': 'no-cache'
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
  const optionByName = new Map();
  options.forEach((item) => optionByName.set(normalizeName(item.name), item));

  for (const market of markets) {
    const candidates = deriveNameCandidates(market.name);
    let found = null;
    let matchReason = '';
    for (const candidate of candidates) {
      if (optionByName.has(candidate)) {
        found = optionByName.get(candidate);
        matchReason = candidate === normalizeName(market.name) ? 'exact' : 'alias';
        break;
      }
    }

    // Fallback only uses the guarded scorer. It deliberately refuses numeric
    // guesses between similarly named pools unless an explicit alias exists.
    if (!found) {
      const scored = options
        .map((item) => ({ item, ...scoreSourceNameMatch(market.name, item.name) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) {
        found = scored[0].item;
        matchReason = scored[0].reason;
      }
    }

    const isManual = market.sourceCodeMode === 'manual';
    if (!isManual) {
      const nextCode = found ? found.code : '';
      if (String(market.sourceCode || '') !== String(nextCode)) {
        market.sourceCode = nextCode;
        changed += 1;
      }
      market.sourceCodeMode = found ? 'auto' : 'auto-unmatched';
    } else if (market.sourceCode) {
      found = options.find((item) => String(item.code) === String(market.sourceCode)) || found;
    }

    mapping.push({
      slug: market.slug,
      market: market.name,
      sourceCode: market.sourceCode || '',
      sourceName: found ? found.name : '',
      matched: !!(market.sourceCode && (found || isManual)),
      mode: market.sourceCodeMode || 'legacy',
      matchReason: found ? (matchReason || (isManual ? 'manual' : 'exact')) : 'unmatched'
    });
  }

  if (persist && changed) saveMarkets(markets);
  else if (persist) saveMarkets(markets); // persist mode migration even if code unchanged
  return { found: options.length, changed, mapping };
}

function comparePeriods(next, previous) {
  if (!previous) return 1;
  const a = Number(next);
  const b = Number(previous);
  if (Number.isFinite(a) && Number.isFinite(b)) return a === b ? 0 : (a > b ? 1 : -1);
  return String(next).localeCompare(String(previous));
}

async function scanMarket(market, settings, state, { force = false, sourceCache = null } = {}) {
  if (market.autoResultEnabled === false) {
    return { market: market.name, slug: market.slug, status: 'disabled' };
  }
  if (!market.sourceCode) {
    return { market: market.name, slug: market.slug, status: 'no_code', error: 'Kode sumber belum diatur/cocok.' };
  }

  const base = normalizeBaseUrl(settings.sourceUrl);
  const endpointTemplate = String(settings.resultPathTemplate || '/history/result/{code}/kosong');
  const path = endpointTemplate.replace('{code}', encodeURIComponent(market.sourceCode));
  const endpoint = new URL(path, `${base}/`).toString();
  let html;
  if (sourceCache && sourceCache.has(endpoint)) {
    html = sourceCache.get(endpoint);
  } else {
    html = await fetchText(endpoint, Number(settings.timeoutMs) || 12000);
    if (sourceCache) sourceCache.set(endpoint, html);
  }
  const rows = parseResultRows(html);
  const latest = selectRowForMarket(rows, market);
  if (!latest) {
    const targetHour = deriveTargetHour(market);
    if (targetHour !== null && rows.length) {
      throw new Error(`Result ${market.name} untuk slot jam ${String(targetHour).padStart(2, '0')}:xx belum ditemukan; data tidak disalin dari slot lain.`);
    }
    throw new Error(`Result ${market.name} tidak ditemukan/format nomor tidak valid di sumber.`);
  }

  const prev = state.markets[market.slug] || {};
  const cmp = comparePeriods(latest.period, prev.period);
  if (!force && prev.period && cmp <= 0) {
    return { market: market.name, slug: market.slug, status: 'unchanged', latest, endpoint };
  }

  if (!force && !prev.period && settings.sendFirstSeen === false) {
    state.markets[market.slug] = {
      period: latest.period,
      prize1: latest.prize1,
      date: latest.date,
      resultTime: latest.resultTime,
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
    resultTime: latest.resultTime,
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
      // Re-validate mappings every scan. This is intentional: a domain change can
      // serve a different pool list and stale codes must never silently be reused.
      try { await detectMarketCodes({ persist: true }); } catch (error) {
        console.error('[AutoResult] auto detect code failed:', error.message);
      }
    }

    settings = getAutoResultSettings();
    const state = getAutoResultState();
    state.markets = state.markets && typeof state.markets === 'object' ? state.markets : {};
    const results = [];
    const sourceCache = new Map();

    for (const market of getMarkets()) {
      try {
        const result = await scanMarket(market, settings, state, { force, sourceCache });
        results.push(result);
      } catch (error) {
        results.push({ market: market.name, slug: market.slug, status: 'error', error: error.message });
      }
    }

    state.lastScanAt = new Date().toISOString();
    state.lastScanStartedAt = startedAt;
    state.lastScanOk = results.every((r) => r.status !== 'error');
    state.lastResults = results.slice(-200);
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
  deriveNameCandidates,
  scoreSourceNameMatch,
  deriveTargetHour,
  selectRowForMarket,
  detectMarketCodes,
  scanOnce,
  startAutoResultWorker,
  stopAutoResultWorker,
  restartAutoResultWorker
};

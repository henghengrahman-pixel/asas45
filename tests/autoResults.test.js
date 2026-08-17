const assert = require('assert');
const {
  parseResultRows,
  selectLatestRow,
  deriveNameCandidates,
  scoreSourceNameMatch,
  deriveTargetHour,
  selectRowForMarket
} = require('../helpers/autoResults');

function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name); throw e; }
}

test('parse 3-column Periode/Tanggal/Nomor', () => {
  const html = `
  <table><thead><tr><th>Periode</th><th>Tanggal</th><th>Nomor</th></tr></thead>
  <tbody>
    <tr><td>2115</td><td>2026-08-16 14:11:21</td><td class="nomor-history">8951</td></tr>
    <tr><td>2116</td><td>2026-08-17 14:11:41</td><td class="nomor-history">2659</td></tr>
  </tbody></table>`;
  const rows = parseResultRows(html);
  assert.equal(rows.length, 2);
  assert.equal(selectLatestRow(rows).period, '2116');
  assert.equal(selectLatestRow(rows).prize1, '2659');
});

test('parse 4-column Periode/Hari/Tanggal/Nomor without reading date as number', () => {
  const html = `
  <table><thead><tr><th>Periode</th><th>Hari</th><th>Tanggal</th><th>Nomor</th></tr></thead>
  <tbody>
    <tr><td>2087</td><td>Senin</td><td>2026-08-17 16:22:10</td><td>7384</td></tr>
  </tbody></table>`;
  const rows = parseResultRows(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].prize1, '7384');
  assert.notEqual(rows[0].prize1, '20260');
  assert.equal(rows[0].date, '2026-08-17');
  assert.equal(rows[0].resultTime, '16:22');
});

test('reject malformed fallback that would convert a date to 20260', () => {
  const html = `<table><tr><td>2087</td><td>Senin</td><td>2026-08-17 16:22:10</td></tr></table>`;
  const rows = parseResultRows(html);
  assert.equal(rows.length, 0);
});

test('prefer proper result table over unrelated table', () => {
  const html = `
    <table><tr><th>ID</th><th>Date</th><th>Value</th></tr><tr><td>1234</td><td>2026-08-17</td><td>9999</td></tr></table>
    <table><tr><th>Periode</th><th>Hari</th><th>Tanggal</th><th>Nomor</th></tr>
      <tr><td>1551</td><td>Senin</td><td>2026-08-17 15:00:00</td><td>4812</td></tr>
    </table>`;
  const rows = parseResultRows(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].period, '1551');
  assert.equal(rows[0].prize1, '4812');
});

test('5-digit result stays intact', () => {
  const html = `<table><tr><th>Periode</th><th>Tanggal</th><th>Nomor</th></tr><tr><td>99</td><td>2026-08-17 15:00:00</td><td>12345</td></tr></table>`;
  const rows = parseResultRows(html);
  assert.equal(rows[0].prize1, '12345');
});

test('strict aliases do not fuzzy-match arbitrary market names', () => {
  assert.deepEqual(deriveNameCandidates('SRI-LANKA'), ['srilanka']);
  assert(deriveNameCandidates('SINGAPORE').includes('singapura'));
  assert(deriveNameCandidates('TOTO MACAU-23').includes('totomacau'));
  assert(!deriveNameCandidates('CHINA EXTRA').includes('china'));
});

test('TOTO MACAU draw slot selects matching hour, not latest row from another slot', () => {
  const rows = [
    { period: '13909', date: '2026-08-17', resultTime: '23:10', prize1: '1143' },
    { period: '13908', date: '2026-08-17', resultTime: '22:10', prize1: '7712' },
    { period: '13907', date: '2026-08-17', resultTime: '21:10', prize1: '6630' },
  ];
  const m22 = { name: 'TOTOMACAU-22' };
  const picked = selectRowForMarket(rows, m22);
  assert.equal(deriveTargetHour(m22), 22);
  assert.equal(picked.period, '13908');
  assert.equal(picked.prize1, '7712');
});

test('slot with no matching row returns null instead of copying another result', () => {
  const rows = [{ period: '13909', date: '2026-08-17', resultTime: '23:10', prize1: '1143' }];
  assert.equal(selectRowForMarket(rows, { name: 'TOTOMACAU-22' }), null);
});


test('explicit local alias OREGON3 maps to source OREGON09', () => {
  const c = deriveNameCandidates('OREGON3');
  assert(c.includes('oregon09'));
  assert.equal(scoreSourceNameMatch('OREGON3', 'OREGON09').reason, 'alias');
});

test('safe formatting alias accepts OREGON9 and OREGON09', () => {
  assert(deriveNameCandidates('OREGON9').includes('oregon09'));
  assert(deriveNameCandidates('OREGON09').includes('oregon9'));
});

test('numbered pools are never fuzzy-guessed to another number', () => {
  assert.equal(scoreSourceNameMatch('OREGON6', 'OREGON09').score, 0);
  assert.equal(scoreSourceNameMatch('OREGON12', 'OREGON09').score, 0);
});


test('TOTOMACAU 5D maps strictly to source TOTO MACAO 5D', () => {
  const c = deriveNameCandidates('TOTOMACAU 5D');
  assert(c.includes('totomacao5d'));
  assert.equal(scoreSourceNameMatch('TOTOMACAU 5D', 'TOTO MACAO 5D').reason, 'alias');
  assert.equal(scoreSourceNameMatch('TOTOMACAU 5D', 'TOTO MACAU POOL').score, 0);
});

test('TOTOMACAU slot 5D maps to TOTO MACAO 5D and keeps its draw hour', () => {
  for (const name of ['TOTOMACAU-15-5D', 'TOTOMACAU-21-5D']) {
    const c = deriveNameCandidates(name);
    assert(c.includes('totomacao5d'));
    assert(!c.includes('totomacau'));
    assert.equal(scoreSourceNameMatch(name, 'TOTO MACAO 5D').reason, 'alias');
  }
  assert.equal(deriveTargetHour({ name: 'TOTOMACAU-15-5D' }), 15);
  assert.equal(deriveTargetHour({ name: 'TOTOMACAU-21-5D' }), 21);
});

test('TOTO MACAO 5D rows are selected per local 5D slot, never copied across hours', () => {
  const rows = [
    { period: '501', date: '2026-08-17', resultTime: '15:10', prize1: '12345' },
    { period: '502', date: '2026-08-17', resultTime: '21:10', prize1: '54321' }
  ];
  assert.equal(selectRowForMarket(rows, { name: 'TOTOMACAU-15-5D' }).prize1, '12345');
  assert.equal(selectRowForMarket(rows, { name: 'TOTOMACAU-21-5D' }).prize1, '54321');
  assert.equal(selectRowForMarket(rows, { name: 'TOTOMACAU-19-5D' }), null);
});



test('multi-prize table always takes Prize 1 / Nomor and preserves leading zero', () => {
  const html = `
  <table><thead><tr>
    <th>Periode</th><th>Hari</th><th>Tanggal</th><th>Nomor</th><th>Nomor 2</th><th>Nomor 3</th>
  </tr></thead><tbody>
    <tr><td>2088</td><td>Senin</td><td>2026-08-17 15:31:29</td><td>0085</td><td>2338</td><td>3852</td></tr>
    <tr><td>2087</td><td>Minggu</td><td>2026-08-16 15:30:29</td><td>3318</td><td>3065</td><td>5613</td></tr>
  </tbody></table>`;
  const rows = parseResultRows(html);
  const latest = selectLatestRow(rows);
  assert.equal(latest.period, '2088');
  assert.equal(latest.prize1, '0085');
  assert.notEqual(latest.prize1, '2338');
  assert.notEqual(latest.prize1, '3852');
  assert.equal(latest._parser, 'prize1-header');
});

test('Nomor 1 / Prize 1 header variants are treated as Prize 1 only', () => {
  for (const h of ['Nomor 1', 'Prize 1', 'Number 1', 'Hasil 1']) {
    const html = `<table><tr><th>Periode</th><th>Tanggal</th><th>${h}</th><th>Nomor 2</th><th>Nomor 3</th></tr>
      <tr><td>9</td><td>2026-08-17 15:31:29</td><td>0007</td><td>2222</td><td>3333</td></tr></table>`;
    const rows = parseResultRows(html);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].prize1, '0007');
  }
});

test('table with Prize 2/3 but missing Prize 1 is rejected, never guessed', () => {
  const html = `<table><tr><th>Periode</th><th>Tanggal</th><th>Nomor 2</th><th>Nomor 3</th></tr>
    <tr><td>9</td><td>2026-08-17 15:31:29</td><td>2222</td><td>3333</td></tr></table>`;
  assert.equal(parseResultRows(html).length, 0);
});


test('headerless 6-column live endpoint takes Nomor/Prize 1, never Nomor 3', () => {
  const html = `<table><tbody>
    <tr><td>1681</td><td>Senin</td><td>2026-08-17 11:58:16</td><td>2679</td><td>2751</td><td>6852</td></tr>
    <tr><td>1680</td><td>Minggu</td><td>2026-08-16 11:52:47</td><td>5194</td><td>2941</td><td>7943</td></tr>
  </tbody></table>`;
  const rows = parseResultRows(html);
  const latest = selectLatestRow(rows);
  assert.equal(rows.length, 2);
  assert.equal(latest.period, '1681');
  assert.equal(latest.prize1, '2679');
  assert.notEqual(latest.prize1, '2751');
  assert.notEqual(latest.prize1, '6852');
  assert.equal(latest._parser, 'after-date-prize1');
});

test('headerless 6-column CHINA preserves leading zero in Prize 1', () => {
  const html = `<table><tr><td>2088</td><td>Senin</td><td>2026-08-17 15:31:29</td><td>0085</td><td>2338</td><td>3852</td></tr></table>`;
  const rows = parseResultRows(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].prize1, '0085');
  assert.equal(rows[0]._parser, 'after-date-prize1');
});

test('headerless wide row without a date is rejected instead of guessing Prize 3', () => {
  const html = `<table><tr><td>1681</td><td>Senin</td><td>2679</td><td>2751</td><td>6852</td></tr></table>`;
  assert.equal(parseResultRows(html).length, 0);
});

console.log('All auto-result parser tests passed.');

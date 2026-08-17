const assert = require('assert');
const {
  parseResultRows,
  selectLatestRow,
  deriveNameCandidates,
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

console.log('All auto-result parser tests passed.');

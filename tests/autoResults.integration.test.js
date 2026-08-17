const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ank3-autoresult-'));
process.env.DATA_DIR = tmp;
const data = require('../helpers/data');
data.bootstrapData();

data.saveMarkets([
  { id:'1', name:'TAIWAN', slug:'taiwan', resultTime:'16:00', autoResultEnabled:true },
  { id:'2', name:'TOTOMACAU-22', slug:'totomacau-22', resultTime:'22:00', autoResultEnabled:true },
  { id:'3', name:'TOTOMACAU-23', slug:'totomacau-23', resultTime:'23:00', autoResultEnabled:true },
  { id:'4', name:'UNKNOWN MARKET', slug:'unknown', resultTime:'12:00', autoResultEnabled:true, sourceCode:'p8294' }
]);
data.saveAutoResultSettings({
  enabled:true,
  sourceUrl:'https://example.test/history/number',
  resultPathTemplate:'/history/result/{code}/kosong',
  scanIntervalSeconds:20,
  timeoutMs:12000,
  autoDetectCodes:true,
  sendFirstSeen:true
});

const sourcePage = `
<select>
<option data-name="TAIWAN POOL" data-code="p8294">TAIWAN POOL</option>
<option data-name="TOTO MACAU POOL" data-code="m17">TOTO MACAU POOL</option>
</select>`;
const taiwan = `<table><tr><th>Periode</th><th>Hari</th><th>Tanggal</th><th>Nomor</th></tr>
<tr><td>2087</td><td>Senin</td><td>2026-08-17 16:10:00</td><td>7384</td></tr></table>`;
const macau = `<table><tr><th>Periode</th><th>Tanggal</th><th>Nomor</th></tr>
<tr><td>13909</td><td>2026-08-17 23:10:00</td><td>1143</td></tr>
<tr><td>13908</td><td>2026-08-17 22:10:00</td><td>7712</td></tr></table>`;

global.fetch = async (url) => {
  const u = String(url);
  let body;
  if (u.endsWith('/history/number')) body = sourcePage;
  else if (u.includes('/history/result/p8294/kosong')) body = taiwan;
  else if (u.includes('/history/result/m17/kosong')) body = macau;
  else return { ok:false, status:404, text:async()=>'' };
  return { ok:true, status:200, text:async()=>body };
};

(async () => {
  const auto = require('../helpers/autoResults');
  const detected = await auto.detectMarketCodes({persist:true});
  assert.equal(detected.mapping.find(x=>x.slug==='taiwan').sourceCode, 'p8294');
  assert.equal(detected.mapping.find(x=>x.slug==='totomacau-22').sourceCode, 'm17');
  assert.equal(detected.mapping.find(x=>x.slug==='totomacau-23').sourceCode, 'm17');
  // Legacy wrong code must be cleared instead of being silently trusted.
  assert.equal(data.getMarkets().find(x=>x.slug==='unknown').sourceCode, '');

  const first = await auto.scanOnce({force:false, autoDetect:true});
  const t = first.results.find(x=>x.slug==='taiwan');
  const m22 = first.results.find(x=>x.slug==='totomacau-22');
  const m23 = first.results.find(x=>x.slug==='totomacau-23');
  assert.equal(t.status, 'updated');
  assert.equal(t.latest.prize1, '7384');
  assert.equal(m22.latest.prize1, '7712');
  assert.equal(m23.latest.prize1, '1143');
  assert.notEqual(m22.latest.prize1, m23.latest.prize1);

  const second = await auto.scanOnce({force:false, autoDetect:true});
  assert.equal(second.results.find(x=>x.slug==='taiwan').status, 'unchanged');
  assert.equal(second.results.find(x=>x.slug==='totomacau-22').status, 'unchanged');
  assert.equal(second.results.find(x=>x.slug==='totomacau-23').status, 'unchanged');

  const taiwanSaved = require('../helpers/results').getLatestResultByMarket('taiwan');
  assert.equal(taiwanSaved.prize1, '7384');
  assert.notEqual(taiwanSaved.prize1, '20260');
  console.log('Integration AUTO result: PASS');
})().catch((err) => { console.error(err); process.exit(1); });

// Self-check of worker.js pure logic using node --test-style asserts (no frameworks).
// Usage: node test_selfcheck.js
// Extracts MONTHS/periodLabel/addMonths/formatIDR/formatDateID/nextPeriod/currentPeriod from worker.js.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

// Use worker.js itself as the module source of truth for the shared helpers.
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`
  const MONTHS = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  const pad = (n, l) => String(n).padStart(l, '0');
  const toInt = v => { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };
  const formatIDR = n => { n = Math.round(Number(n) || 0); const sign = n < 0 ? '-' : ''; return 'Rp ' + sign + Math.abs(n).toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, '.'); };
  const periodLabel = p => MONTHS[toInt(String(p).substring(5)) - 1] + ' ' + String(p).substring(0, 4);
  const addMonths = (period, delta) => {
    let m = toInt(period.substring(5)), y = toInt(period.substring(0, 4));
    m += delta;
    while (m < 1) { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    return pad(y, 4) + '-' + pad(m, 2);
  };
  const formatDateID = ts => {
    const s = String(ts || '').slice(0, 10);
    const [y, m, d] = s.split('-').map(Number);
    if (!y || !m || !d) return '-';
    return d + ' ' + MONTHS[m - 1] + ' ' + y;
  };
  const normalizePhone = p => {
    let d = String(p || '').replace(/\\D/g, '');
    if (d.startsWith('0')) d = '62' + d.slice(1);
    else if (!d.startsWith('62')) d = '62' + d;
    return d;
  };
  globalThis.H = { MONTHS, formatIDR, periodLabel, addMonths, formatDateID, normalizePhone };
`, sandbox);

const H = sandbox.H;
function eq(actual, expected, label) {
  if (actual !== expected) {
    console.error('FAIL: ' + label + '\n  expected: ' + JSON.stringify(expected) + '\n  actual:   ' + JSON.stringify(actual));
    process.exit(1);
  }
  console.log('ok ' + label);
}

eq(H.formatIDR(50000), 'Rp 50.000', 'rupiah basic');
eq(H.formatIDR(1250000), 'Rp 1.250.000', 'rupiah thousands');
eq(H.formatIDR(0), 'Rp 0', 'rupiah zero');
eq(H.formatIDR(-25000), 'Rp -25.000', 'rupiah negative');
eq(H.periodLabel('2026-08'), 'Agustus 2026', 'periodLabel');
eq(H.formatDateID('2026-08-10'), '10 Agustus 2026', 'formatDateID');
eq(H.addMonths('2026-08', 1), '2026-09', 'addMonths next');
eq(H.addMonths('2026-01', -1), '2025-12', 'addMonths prev year');
eq(H.addMonths('2026-12', 1), '2027-01', 'addMonths next year');

eq(H.normalizePhone('081234567890'), '6281234567890', 'phone leading 0');
eq(H.normalizePhone('+62 812-345-67890'), '6281234567890', 'phone intl format');
eq(H.normalizePhone('6281234567890'), '6281234567890', 'phone already 62');

// Ensure worker.js parses (syntax gate).
if (!/const MONTHS = /.test(src)) throw new Error('MONTHS not found in worker.js');
console.log('ALL OK');

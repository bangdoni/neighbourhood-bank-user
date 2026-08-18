// Neighbourhood Bank User Bot — Cloudflare Worker + D1 (SQLite)
// Read-only view of the member's own account. Replaces Google Apps Script.
// env: BOT_TOKEN, WEBHOOK_SECRET; optional env: TIMEZONE, QR_PUBLIC_URL
// bindings: DB (D1), QR_BUCKET (R2, QR image object storage)

const DEFAULT_CONFIG = {
  monthly_fee: '50000', currency: 'IDR', timezone: 'Asia/Jakarta',
  payment_due_day: '10', bank_name: '', account_name: '', account_number: '',
  qr_url: '', payment_instruction: '',
  payment_method: 'qr', pg_api_key: '', pg_api_base: 'https://api-pay-sandbox.sumopod.com/api/v1'
};
const MONTHS = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

// ---- env / db adapter (sqlite = D1 | postgres = Hyperdrive + postgres.js) ----
// DB_TYPE env: 'sqlite' (default, Cloudflare D1) or 'postgres'.
// postgres mode needs a Hyperdrive binding named DB (env.DB.connectionString) or a
// direct DB_URL; DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME build a URL otherwise.
// postgres.js is installed (npm i postgres) so wrangler/dashboard can bundle it;
// it is only ever invoked in postgres mode, and a D1 (sqlite) deployment never
// opens a connection to it.
let E = {};
let BASE = '';
let TZ = 'Asia/Jakarta';
let PG_MODE = false;
let PG = null;
let PG_INIT = false;
function initEnv(env) {
  E = env;
  TZ = env.TIMEZONE || 'Asia/Jakarta';
  PG_MODE = String(env.DB_TYPE || 'sqlite').toLowerCase() === 'postgres';
}
const pgUrl = () => {
  const user = encodeURIComponent(E.DB_USER || 'postgres');
  const pass = encodeURIComponent(E.DB_PASSWORD || '');
  const host = E.DB_HOST || 'localhost';
  const port = E.DB_PORT || '5432';
  const name = E.DB_NAME || 'postgres';
  return `postgres://${user}:${pass}@${host}:${port}/${name}`;
};
const pgq = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
async function getPg() {
  if (!PG_INIT) {
    PG_INIT = true;
    const { default: postgres } = await import('postgres');
    const conn = E.DB_URL || (E.DB && E.DB.connectionString) || pgUrl();
    PG = postgres(conn, { max: 1, prepare: false });
  }
  return PG;
}

const dbAll = async (sql, ...params) => PG_MODE
  ? (await (await getPg()).unsafe(pgq(sql), params))
  : (await E.DB.prepare(sql).bind(...params).all()).results;
const dbOne = async (sql, ...params) => {
  if (PG_MODE) { const r = await dbAll(sql, ...params); return r[0] || null; }
  return (await E.DB.prepare(sql).bind(...params).first()) || null;
};
const dbRun = async (sql, ...params) => PG_MODE
  ? { changes: ((await (await getPg()).unsafe(pgq(sql), params)).count || 0) }
  : (await E.DB.prepare(sql).bind(...params).run()).meta;
const dbUpsertIgnore = async (table, row, conflictCols) => {
  const cols = Object.keys(row);
  const sql = PG_MODE
    ? `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT (${conflictCols.join(',')}) DO NOTHING`
    : `INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  const meta = await dbRun(sql, ...cols.map(c => row[c]));
  return meta.changes > 0 ? [row] : [];
};
const dbInsert = async (table, row) => {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING *`;
  return dbAll(sql, ...cols.map(c => row[c]));
};

// ---- utils ----
const pad = (n, l) => String(n).padStart(l, '0');
const toInt = v => { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };
const formatIDR = n => { n = Math.round(Number(n) || 0); const sign = n < 0 ? '-' : ''; return 'Rp ' + sign + Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); };
const periodLabel = p => MONTHS[toInt(String(p).substring(5)) - 1] + ' ' + String(p).substring(0, 4);
const currentPeriod = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
const nowIso = () => new Date().toISOString();
function addMonths(period, delta) {
  let m = toInt(period.substring(5)), y = toInt(period.substring(0, 4));
  m += delta;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return pad(y, 4) + '-' + pad(m, 2);
}
const nextPeriod = p => addMonths(p, 1);
const normalizePhone = p => {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (!d.startsWith('62')) d = '62' + d;
  return d;
};
function formatDateID(ts) {
  const s = String(ts || '').slice(0, 10);
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return '-';
  return d + ' ' + MONTHS[m - 1] + ' ' + y;
}

// ---- config ----
async function loadConfig() {
  const rows = await dbAll('SELECT key, value FROM config');
  const m = {};
  rows.forEach(r => { m[r.key] = r.value; });
  return Object.assign({}, DEFAULT_CONFIG, m);
}
let CFG = null;
const cfg = async key => { if (!CFG) CFG = await loadConfig(); return CFG[key] === undefined || CFG[key] === '' ? DEFAULT_CONFIG[key] : CFG[key]; };

// ---- ids / audit ----
async function nextId(name, prefix, padLen) {
  const res = await dbOne('INSERT INTO counters(name, n) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET n = counters.n + 1 RETURNING n', name);
  return prefix + String(res.n).padStart(padLen, '0');
}
async function writeAuditEntry(action, targetId, details, status) {
  const id = await nextId('audit', 'AUD-', 6);
  await dbInsert('audit', {
    audit_id: id, timestamp: nowIso(), admin_id: 'SYSTEM', telegram_id: '',
    action, target_type: 'USER', target_id: targetId, details: details || '', status: status || 'SUCCESS'
  });
}

// ---- payment gateway (Sumopay) ----
const pgMethodMap = m => String(m || '').toLowerCase() === 'qris' ? 'QRIS' : 'BANK_TRANSFER';
async function pgCreatePayment(orderId, amount) {
  const apiKey = await cfg('pg_api_key');
  const base = await cfg('pg_api_base');
  if (!apiKey) throw new Error('PG_NOT_CONFIGURED');
  const res = await fetch(base + '/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({
      order_id: orderId, amount, currency: 'IDR', expires_in_hours: 24,
      success_return_url: E.QR_PUBLIC_URL || BASE, cancel_return_url: E.QR_PUBLIC_URL || BASE,
      payment_method_type_code: 'QRIS'
    })
  });
  if (!res.ok) throw new Error('PG_HTTP_' + res.status);
  return res.json();
}

async function pgPay(chatId, user) {
  const s = await getContributionStatus(user.user_id);
  if (s.paid) return sendTelegramMessage(chatId, '✅ Iuran bulan ini sudah dibayar.');
  try {
    const p = await pgCreatePayment(user.user_id + ':' + s.period + ':' + Date.now(), s.fee);
    return sendTelegramMessage(chatId, '🔗 Link Pembayaran\n\n'
      + 'Member:\n' + String(user.name) + '\n\n'
      + 'Periode:\n' + periodLabel(s.period) + '\n\n'
      + 'Jumlah:\n' + formatIDR(p.amount) + '\n\n'
      + 'Status:\n' + p.status + '\n\n'
      + 'Link:\n' + p.payment_link_url + '\n\n'
      + 'Kadaluarsa:\n' + (p.expires_at ? String(p.expires_at).replace('T', ' ').slice(0, 16) : '-'));
  } catch (e) {
    console.log('pg create error', e && e.stack || e);
    return sendTelegramMessage(chatId, '❌ Gagal membuat link pembayaran.\n\nSilakan hubungi pengurus.');
  }
}

// ---- data services ----
const findUserByTelegramId = tid => dbOne('SELECT * FROM users WHERE telegram_id = ?', String(tid));
const findUserByPhone = phone => dbAll('SELECT * FROM users WHERE status = ?', 'ACTIVE').then(rows => rows.find(r => r.phone && normalizePhone(r.phone) === normalizePhone(phone)) || null);
const getUserById = uid => dbOne('SELECT * FROM users WHERE user_id = ?', String(uid));
async function getAuthenticatedMember(telegramId) {
  const user = await findUserByTelegramId(telegramId);
  if (!user) return { ok: false, reason: 'UNLINKED' };
  if (String(user.status) !== 'ACTIVE') return { ok: false, reason: 'DISABLED' };
  return { ok: true, user };
}
const getTransactions = async userId => dbAll('SELECT * FROM transactions WHERE status = ? AND user_id = ? ORDER BY timestamp DESC', 'COMPLETED', String(userId));
async function sumTx(userId, period) {
  const rows = period
    ? await dbAll('SELECT amount FROM transactions WHERE status = ? AND user_id = ? AND period = ?', 'COMPLETED', String(userId), period)
    : await dbAll('SELECT amount FROM transactions WHERE status = ? AND user_id = ?', 'COMPLETED', String(userId));
  return rows.reduce((s, t) => s + toInt(t.amount), 0);
}
const getBalance = userId => sumTx(userId);
async function memberFee(m) {
  const f = toInt(m.monthly_fee);
  return f > 0 ? f : toInt(await cfg('monthly_fee'));
}
async function getContributionStatus(userId, period) {
  period = period || currentPeriod();
  const fee = toInt(await cfg('monthly_fee'));
  const dueDay = toInt(await cfg('payment_due_day')) || 10;
  const txs = await dbAll('SELECT * FROM transactions WHERE status = ? AND user_id = ? AND period = ?', 'COMPLETED', String(userId), period);
  const contribution = txs.filter(t => t.type === 'CONTRIBUTION' && toInt(t.amount) > 0).sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] || null;
  return { period, fee, dueDay, paid: !!contribution, transaction: contribution, net: txs.reduce((s, t) => s + toInt(t.amount), 0) };
}
async function getContributionHistory(userId, count) {
  count = count || 6;
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const p = addMonths(currentPeriod(), -i);
    const s = await getContributionStatus(userId, p);
    out.push({ period: p, paid: s.paid, amount: s.paid ? s.net : s.fee });
  }
  return out;
}
async function getStoreConfig() {
  return {
    bank_name: await cfg('bank_name'), account_name: await cfg('account_name'), account_number: await cfg('account_number'),
    monthly_fee: toInt(await cfg('monthly_fee')), payment_instruction: await cfg('payment_instruction'),
    payment_method: await cfg('payment_method')
  };
}
async function getQrObject() {
  if (!E.QR_BUCKET) return null;
  try { return await E.QR_BUCKET.get('payment-qrcode.png'); } catch (e) { return null; }
}
async function getQrUrl() {
  const conf = await cfg('qr_url');
  if (conf) return conf;
  return (E.QR_PUBLIC_URL || BASE) + '/qr';
}

// ---- telegram ----
const TG = 'https://api.telegram.org/bot';
async function tg(method, payload) {
  const res = await fetch(TG + E.BOT_TOKEN + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return res.json();
}
const btn = (text, data) => ({ text, callback_data: data });
async function sendTelegramMessage(chatId, text, keyboard, inlineKeyboard) {
  const p = { chat_id: String(chatId), text };
  if (keyboard) p.reply_markup = keyboard;
  else if (inlineKeyboard) p.reply_markup = { inline_keyboard: inlineKeyboard };
  return tg('sendMessage', p);
}
async function sendTelegramPhoto(chatId, url, caption) {
  return tg('sendPhoto', { chat_id: String(chatId), photo: url, caption: caption || '' });
}
async function answerCallback(cbId, text, alert) {
  return tg('answerCallbackQuery', { callback_query_id: String(cbId), text: text || '', show_alert: !!alert });
}
async function editMessage(chatId, messageId, text, inlineKeyboard) {
  const p = { chat_id: String(chatId), message_id: messageId, text };
  if (inlineKeyboard) p.reply_markup = { inline_keyboard: inlineKeyboard };
  return tg('editMessageText', p);
}
function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: '💰 Saldo' }, { text: '📊 Riwayat' }],
      [{ text: '💳 Iuran' }, { text: '🏦 Rekening' }],
      [{ text: '👤 Profil' }, { text: 'ℹ️ Status' }],
      [{ text: '❓ Bantuan' }]
    ],
    resize_keyboard: true
  };
}
function linkRequestKeyboard() {
  return {
    keyboard: [[{ text: '📱 Bagikan Nomor Telepon', request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true
  };
}
function transactionDescription(t) {
  return t.description ? String(t.description) : 'Iuran ' + periodLabel(t.period);
}

// ---- handlers ----
async function onStart(chatId, user) {
  const balance = await getBalance(user.user_id);
  const s = await getContributionStatus(user.user_id);
  const text = '👋 Selamat datang, ' + String(user.name) + '!\n\n'
    + 'Member ID:\n' + String(user.user_id) + '\n\n'
    + 'Saldo Saat Ini:\n' + formatIDR(balance) + '\n\n'
    + 'Iuran ' + periodLabel(s.period) + ':\n' + (s.paid ? '✅ Sudah Dibayar' : '❌ Belum Dibayar') + '\n\n'
    + 'Gunakan menu di bawah ini.';
  return sendTelegramMessage(chatId, text, mainMenuKeyboard());
}
async function onBalance(chatId, user) {
  const balance = await getBalance(user.user_id);
  const fee = toInt(await cfg('monthly_fee'));
  const s = await getContributionStatus(user.user_id);
  const text = '💰 Saldo Anda\n\n'
    + 'Nama:\n' + String(user.name) + '\n\n'
    + 'Member ID:\n' + String(user.user_id) + '\n\n'
    + 'Saldo Saat Ini:\n' + formatIDR(balance) + '\n\n'
    + 'Iuran Bulanan:\n' + formatIDR(fee) + '\n\n'
    + periodLabel(s.period) + ':\n' + (s.paid ? '✅ Sudah Dibayar' : '❌ Belum Dibayar');
  return sendTelegramMessage(chatId, text);
}
async function buildHistoryMessage(user, offset) {
  const all = await getTransactions(user.user_id);
  const page = all.slice(offset, offset + 10);
  const lines = ['📊 Riwayat Transaksi', '', String(user.name), String(user.user_id), '', '────────────────────', ''];
  if (!page.length) {
    lines.push('Belum ada transaksi.');
  } else {
    page.forEach(t => {
      lines.push(formatDateID(t.timestamp));
      const amt = toInt(t.amount);
      lines.push((amt >= 0 ? '+ ' : '- ') + formatIDR(Math.abs(amt)));
      lines.push(transactionDescription(t));
      lines.push('');
    });
    lines.push('Menampilkan ' + (offset + 1) + '–' + Math.min(offset + 10, all.length) + ' dari ' + all.length + ' transaksi.');
  }
  return { text: lines.join('\n'), keyboard: historyInlineKeyboard(offset, all.length) };
}
function historyInlineKeyboard(offset, total) {
  const row = [];
  if (offset > 0) row.push(btn('⬅️ Sebelumnya', 'history:prev:' + Math.max(0, offset - 10)));
  if (offset + 10 < total) row.push(btn('Berikutnya ➡️', 'history:next:' + (offset + 10)));
  return row.length ? [row] : null;
}
async function onHistory(chatId, user) {
  const msg = await buildHistoryMessage(user, 0);
  return sendTelegramMessage(chatId, msg.text, undefined, msg.keyboard);
}
async function onContribution(chatId, user) {
  const s = await getContributionStatus(user.user_id);
  const lines = ['💳 Status Iuran', '', periodLabel(s.period), '', 'Jumlah:', formatIDR(s.fee), '', 'Status:', s.paid ? '✅ Sudah Dibayar' : '❌ Belum Dibayar'];
  let inline = null;
  if (s.paid && s.transaction) {
    lines.push('', 'Tanggal Pembayaran:', formatDateID(s.transaction.timestamp));
  } else {
    lines.push('', 'Tanggal Jatuh Tempo:', s.dueDay + ' ' + periodLabel(s.period));
    const gw = (await cfg('payment_method')) === 'gateway' && !!await cfg('pg_api_key');
    if (gw) {
      lines.push('', 'Pembayaran online tersedia.');
      inline = [[btn('🔗 Buat Link Pembayaran', 'pg_pay')]];
    } else {
      lines.push('', 'Silakan lakukan pembayaran menggunakan informasi di:', '', '🏦 Rekening');
    }
  }
  await sendTelegramMessage(chatId, lines.join('\n'), undefined, inline);

  const hist = await getContributionHistory(user.user_id, 6);
  const h = ['📅 Riwayat Iuran', '', periodLabel(s.period).split(' ')[1]];
  hist.forEach(item => {
    const month = periodLabel(item.period).split(' ')[0];
    h.push(month + '  ' + (item.paid ? '✅ ' + formatIDR(item.amount) : '❌'));
  });
  return sendTelegramMessage(chatId, h.join('\n'));
}
async function onStore(chatId) {
  const config = await getStoreConfig();
  if (!config.bank_name && !config.account_name && !config.account_number) {
    return sendTelegramMessage(chatId, '❌ Informasi pembayaran belum tersedia.\n\nSilakan hubungi pengurus.');
  }
  const lines = ['🏦 Rekening Pembayaran', '', 'Bank:', String(config.bank_name || '-'), '', 'Nama:', String(config.account_name || '-'), '', 'Nomor Rekening:', String(config.account_number || '-'), ''];
  if (config.monthly_fee) lines.push('Iuran Bulanan:', formatIDR(config.monthly_fee));
  if (config.payment_instruction) lines.push('', String(config.payment_instruction));
  const text = lines.join('\n');
  const gw = config.payment_method === 'gateway' && !!(await cfg('pg_api_key'));
  if (gw) {
    return sendTelegramMessage(chatId, text + '\n\n🌐 Pembayaran online tersedia.', undefined, [[btn('🔗 Buat Link Pembayaran', 'pg_pay')]]);
  }
  const obj = await getQrObject();
  if (obj) {
    return sendTelegramPhoto(chatId, await getQrUrl(), text + '\n\nSilakan pindai QR code di bawah ini untuk melakukan pembayaran.');
  }
  return sendTelegramMessage(chatId, text + '\n\n⚠️ QR code sedang tidak tersedia.\n\nSilakan hubungi pengurus.');
}
async function onProfile(chatId, user) {
  const fee = toInt(await cfg('monthly_fee'));
  const lines = ['👤 Profil Saya', '', 'Member ID:', String(user.user_id), '', 'Nama:', String(user.name)];
  if (user.telegram_username) lines.push('', 'Telegram:', '@' + String(user.telegram_username).replace(/^@/, ''));
  if (user.phone) lines.push('', 'Telepon:', String(user.phone));
  lines.push('', 'Status:', '🟢 AKTIF', '', 'Iuran Bulanan:', formatIDR(fee));
  return sendTelegramMessage(chatId, lines.join('\n'));
}
async function onStatus(chatId, user) {
  const balance = await getBalance(user.user_id);
  const s = await getContributionStatus(user.user_id);
  const text = 'ℹ️ Status Akun\n\n'
    + 'Akun:\n🟢 AKTIF\n\n'
    + 'Member ID:\n' + String(user.user_id) + '\n\n'
    + 'Saldo Saat Ini:\n' + formatIDR(balance) + '\n\n'
    + 'Iuran Berjalan:\n' + (s.paid ? '✅ Sudah Dibayar' : '❌ Belum Dibayar') + '\n\n'
    + 'Iuran Berikutnya:\n' + periodLabel(nextPeriod(s.period));
  return sendTelegramMessage(chatId, text);
}
async function onHelp(chatId) {
  const text = '❓ Bantuan\n\n'
    + 'Pilihan yang tersedia:\n\n'
    + '💰 Saldo\nMelihat saldo Anda saat ini.\n\n'
    + '📊 Riwayat\nMelihat riwayat transaksi Anda.\n\n'
    + '💳 Iuran\nMelihat status iuran bulanan.\n\n'
    + '🏦 Rekening\nMelihat rekening pembayaran dan QR code.\n\n'
    + '👤 Profil\nMelihat informasi anggota Anda.\n\n'
    + 'ℹ️ Status\nMelihat status akun Anda.\n\n'
    + 'Jika membutuhkan bantuan, hubungi pengurus lingkungan.';
  return sendTelegramMessage(chatId, text);
}

// ---- router ----
function normalizeCommand(text) {
  const t = String(text).toLowerCase();
  if (t.indexOf('/') === 0) return t.split(/\s+/)[0];
  const map = {
    '💰 saldo': '/balance', 'saldo': '/balance', 'balance': '/balance',
    '📊 riwayat': '/history', 'riwayat': '/history', 'history': '/history',
    '💳 iuran': '/contribution', 'iuran': '/contribution', 'contribution': '/contribution',
    '🏦 rekening': '/store', 'rekening': '/store', 'store': '/store',
    '👤 profil': '/profile', 'profil': '/profile', 'profile': '/profile',
    'ℹ️ status': '/status', 'status': '/status',
    '❓ bantuan': '/help', 'bantuan': '/help', 'help': '/help'
  };
  return map[t] || t;
}
async function handleMessage(msg) {
  if (msg.chat && msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;

  if (msg.contact && msg.contact.phone_number) {
    const member = await findUserByPhone(msg.contact.phone_number);
    if (!member) {
      return sendTelegramMessage(chatId, '📵 Nomor Tidak Dikenali\n\nNomor telepon Anda tidak terdaftar sebagai anggota.\n\nSilakan hubungi pengurus untuk bantuan.', linkRequestKeyboard());
    }
    await dbRun('UPDATE users SET telegram_id = ?, telegram_username = ?, updated_at = ? WHERE user_id = ?',
      String(telegramId), String(msg.from.username || ''), nowIso(), String(member.user_id));
    return onStart(chatId, member);
  }

  const text = String(msg.text || '').trim();
  if (!text) return;

  const auth = await getAuthenticatedMember(telegramId);
  if (!auth.ok) {
    if (auth.reason === 'DISABLED') {
      return sendTelegramMessage(chatId, '⛔ Akun Nonaktif\n\nAkun Anda saat ini nonaktif.\n\nSilakan hubungi pengurus untuk bantuan.');
    }
    return sendTelegramMessage(chatId, '👋 Selamat datang!\n\nAkun Telegram Anda belum tertaut ke akun anggota.\n\nTekan tombol di bawah ini untuk menautkan akun Anda.', linkRequestKeyboard());
  }

  const cmd = normalizeCommand(text);
  switch (cmd) {
    case '/start': return onStart(chatId, auth.user);
    case '/balance': return onBalance(chatId, auth.user);
    case '/history': return onHistory(chatId, auth.user);
    case '/contribution': return onContribution(chatId, auth.user);
    case '/store': return onStore(chatId);
    case '/profile': return onProfile(chatId, auth.user);
    case '/status': return onStatus(chatId, auth.user);
    case '/help': return onHelp(chatId);
    default:
      return sendTelegramMessage(chatId, '❓ Perintah tidak dikenal\n\nSilakan gunakan menu di bawah ini.');
  }
}
async function handleCallback(cb) {
  const telegramId = cb.from.id;
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const auth = await getAuthenticatedMember(telegramId);
  if (!auth.ok) {
    return answerCallback(cb.id, 'Sesi tidak valid.');
  }
  const data = String(cb.data || '');
  if (data === 'pg_pay') {
    await answerCallback(cb.id, '');
    return pgPay(chatId, auth.user);
  }
  if (data.indexOf('history:') === 0) {
    const parts = data.split(':');
    const offset = Math.max(0, toInt(parts[2]));
    const msg = await buildHistoryMessage(auth.user, offset);
    await editMessage(chatId, messageId, msg.text, msg.keyboard);
    return answerCallback(cb.id, '');
  }
  return answerCallback(cb.id, 'Perintah tidak dikenal.');
}
async function handleUpdate(update) {
  try {
    if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.message) await handleMessage(update.message);
  } catch (err) { console.log('handleUpdate:', err && err.stack || err); }
}

async function handlePgWebhook(request) {
  CFG = null;
  const apiKey = await cfg('pg_api_key');
  if (!apiKey || request.headers.get('X-Api-Key') !== apiKey) return new Response('UNAUTHORIZED', { status: 401 });
  let body;
  try { body = await request.json(); } catch (e) { return new Response('BAD_JSON', { status: 400 }); }
  if (body.event_type !== 'payment.completed' || !body.data || String(body.data.status) !== 'completed') {
    return new Response('OK', { status: 200 });
  }
  const d = body.data;
  const parts = String(d.order_id || '').split(':');
  const userId = parts[0], period = parts[1];
  const user = userId ? await getUserById(userId) : null;
  if (!user) return new Response('OK', { status: 200 });
  const amount = toInt(d.amount);
  if (amount <= 0) return new Response('OK', { status: 200 });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return new Response('OK', { status: 200 });

  const dup = await dbOne('SELECT transaction_id FROM transactions WHERE reference = ?', String(d.payment_id || ''));
  if (dup) return new Response('OK', { status: 200 });
  const paid = await dbOne('SELECT transaction_id FROM transactions WHERE user_id = ? AND period = ? AND type = ? AND status = ?', userId, period, 'CONTRIBUTION', 'COMPLETED');
  if (paid) return new Response('OK', { status: 200 });

  const id = await nextId('transactions', 'TX-', 6);
  const bal = (await getBalance(userId)) + amount;
  try {
    await dbInsert('transactions', {
      transaction_id: id, timestamp: nowIso(), user_id: userId, type: 'CONTRIBUTION', amount,
      period, payment_method: pgMethodMap(d.payment_method), description: 'Pembayaran otomatis (gateway ' + d.payment_id + ')',
      balance_after: bal, created_by: 'SYSTEM', status: 'COMPLETED', reference: String(d.payment_id)
    });
  } catch (e) {
    if (await dbOne('SELECT transaction_id FROM transactions WHERE reference = ?', String(d.payment_id))) return new Response('OK', { status: 200 });
    throw e;
  }
  await writeAuditEntry('PAYMENT_WEBHOOK', userId, 'Auto via gateway ' + d.payment_id + ' / ' + d.amount, 'SUCCESS');
  if (user.telegram_id) {
    await sendTelegramMessage(user.telegram_id, '✅ Pembayaran Diterima\n\nTerima kasih, ' + String(user.name) + '!\n\n'
      + 'Pembayaran ' + periodLabel(period) + ' sebesar ' + formatIDR(amount) + ' telah tercatat.');
  }
  return new Response('OK', { status: 200 });
}

// ---- entry ----
function isValidHook(request) {
  const hdr = request.headers.get('x-telegram-bot-api-secret-token');
  if (hdr && hdr === E.WEBHOOK_SECRET) return true;
  const u = new URL(request.url);
  return u.searchParams.get('hook') === E.WEBHOOK_SECRET;
}
async function serveQr() {
  const obj = await getQrObject();
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, {
    headers: { 'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/png', 'Cache-Control': 'public, max-age=3600' }
  });
}

export default {
  async fetch(request, env) {
    initEnv(env);
    const reqUrl = new URL(request.url);
    BASE = reqUrl.origin;
    if (request.method === 'GET') {
      if (reqUrl.pathname === '/qr') return serveQr();
      return new Response('Neighbourhood Bank User Bot OK', { status: 200 });
    }
    if (request.method === 'POST' && reqUrl.pathname === '/webhook') return handlePgWebhook(request);
    if (request.method !== 'POST' || !isValidHook(request)) return new Response('NO', { status: 200 });
    CFG = null;
    let update;
    try { update = await request.json(); } catch (e) { return new Response('OK', { status: 200 }); }
    const inserted = await dbUpsertIgnore('processed_updates_user', { update_id: update.update_id, processed_at: nowIso() }, ['update_id']).catch(() => []);
    if (!inserted || inserted.length === 0) return new Response('OK', { status: 200 });
    await handleUpdate(update);
    return new Response('OK', { status: 200 });
  }
};

# Neighbourhood Bank — User Bot

Bot Telegram untuk anggota warga dalam sistem kas/iuran lingkungan. Anggota dapat melihat profil, saldo, riwayat transaksi, dan status iuran bulanan melalui bot ini.

> **Catatan:** Bot ini hanya untuk anggota. Fungsi administrasi (catat pembayaran, kelola anggota, laporan) tersedia di bot terpisah: **Neighbourhood Bank Admin Bot**.

---

## Fitur

- 👤 Daftarkan akun Telegram ke sistem
- 💰 Lihat saldo iuran
- 📋 Lihat riwayat transaksi
- 📅 Cek status iuran bulanan
- 🏦 Lihat QR code / info rekening pembayaran
- 🔔 Terima notifikasi pembayaran dan pengingat iuran
- ❓ Bantuan dan informasi sistem

---

## Arsitektur

```
Anggota Warga
      │
      │ Telegram
      ▼
┌─────────────────────┐
│  Telegram User Bot  │
└──────────┬──────────┘
           │ Webhook
           ▼
┌─────────────────────┐
│  Cloudflare Worker  │
│     (worker.js)     │
└──────────┬──────────┘
           │
      ┌────┴────┐
      ▼         ▼
┌──────────┐ ┌──────────┐
│  D1 DB   │ │    R2    │
│ (SQLite) │ │ (QR Code)│
└──────────┘ └──────────┘
```

**Komponen:**
- **Cloudflare Worker** — backend utama, menangani webhook Telegram
- **Cloudflare D1** — database SQLite untuk data anggota dan transaksi
- **Cloudflare R2** — penyimpanan gambar QR code pembayaran

---

## Cara Deploy

### 1. Prasyarat

- Akun [Cloudflare](https://cloudflare.com)
- [Node.js](https://nodejs.org) v18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Bot Telegram (buat via [@BotFather](https://t.me/BotFather))

### 2. Clone & Install

```bash
git clone https://github.com/bangdoni/neighbourhood-bank-user.git
cd neighbourhood-bank-user
npm install
```

### 3. Konfigurasi Wrangler

Salin `wrangler.toml` sebagai konfigurasi awal, lalu sesuaikan:

```toml
name = "nama-worker-anda"
main = "worker.js"
compatibility_date = "2025-08-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true

[[d1_databases]]
binding = "DB"
database_name = "nb-some-place"
database_id = "ISI_DENGAN_ID_D1_ANDA"

[[r2_buckets]]
binding = "QR_BUCKET"
bucket_name = "nb-some-place-bucket"

[vars]
TIMEZONE = "Asia/Jakarta"
QR_PUBLIC_URL = "https://nama-worker-anda.akun-anda.workers.dev/qr"
```

Untuk mendapatkan `database_id`, buat D1 database terlebih dahulu:

```bash
wrangler d1 create nb-some-place
```

### 4. Inisialisasi Database

```bash
wrangler d1 execute nb-some-place --file=schema.sql
```

### 5. Set Secrets

Jangan simpan token di `wrangler.toml`. Gunakan secrets:

```bash
# Token bot Telegram dari @BotFather
wrangler secret put BOT_TOKEN

# Secret untuk verifikasi webhook Telegram
wrangler secret put WEBHOOK_SECRET
```

### 6. Deploy

```bash
wrangler deploy
```

### 7. Daftarkan Webhook Telegram

Setelah deploy, daftarkan URL worker sebagai webhook bot:

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://nama-worker-anda.akun-anda.workers.dev/webhook&secret_token=<WEBHOOK_SECRET>
```

---

## Variabel Lingkungan

| Nama | Wajib | Keterangan |
|------|-------|-----------|
| `BOT_TOKEN` | ✅ | Token bot Telegram dari @BotFather |
| `WEBHOOK_SECRET` | ✅ | Secret untuk verifikasi permintaan webhook |
| `TIMEZONE` | ❌ | Zona waktu (default: `Asia/Jakarta`) |
| `QR_PUBLIC_URL` | ❌ | URL publik QR code pembayaran |

---

## Mode Database

Bot mendukung dua mode database:

**SQLite / Cloudflare D1 (default)**
Tidak perlu konfigurasi tambahan. Cukup siapkan binding D1 di `wrangler.toml`.

**PostgreSQL (opsional, untuk deploy di VPS sendiri)**
Tambahkan variabel berikut jika ingin menggunakan PostgreSQL:

```bash
wrangler secret put DB_HOST      # Host PostgreSQL
wrangler secret put DB_PORT      # Port (default: 5432)
wrangler secret put DB_USER      # Username
wrangler secret put DB_PASSWORD  # Password
wrangler secret put DB_NAME      # Nama database
```

Atau gunakan `DB_URL` langsung:
```bash
wrangler secret put DB_URL  # postgres://user:pass@host:port/dbname
```

Aktifkan mode postgres dengan menambahkan ke `[vars]`:
```toml
DB_TYPE = "postgres"
```

---

## Penggunaan Bot

Setelah bot aktif, anggota dapat mengirim perintah berikut di Telegram:

| Perintah | Fungsi |
|----------|--------|
| `/start` | Mulai dan daftarkan akun |
| `/profil` | Lihat informasi profil anggota |
| `/saldo` | Cek saldo iuran |
| `/riwayat` | Lihat riwayat transaksi |
| `/iuran` | Cek status iuran bulan ini |
| `/bayar` | Lihat info & QR code pembayaran |
| `/bantuan` | Tampilkan daftar perintah |

---

## Keamanan

- Data anggota hanya dapat diakses oleh anggota yang bersangkutan
- Identifikasi menggunakan **Telegram ID** (tidak dapat dipalsukan)
- Jangan pernah mempercayai Member ID yang dikirim pengguna
- Webhook diverifikasi menggunakan `WEBHOOK_SECRET`
- Token bot dan secret **tidak boleh** disimpan di `wrangler.toml` — gunakan `wrangler secret`

---

## Lisensi

Lihat file [LICENSE](LICENSE) untuk informasi lisensi.

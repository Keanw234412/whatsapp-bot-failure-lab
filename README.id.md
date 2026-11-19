# WhatsApp Bot Failure Lab

[English](README.md) · **Bahasa Indonesia**

**Temukan bug yang bikin bot WhatsApp malu-maluin di depan pelanggan, langsung di laptop, sebelum
launching.** Balasan dobel saat Meta mengirim ulang webhook, crash karena laporan status pengiriman, ack yang
lambat sehingga Meta kirim ulang lagi, request palsu yang membuat bot mengirim pesan, dan balasan yang nyasar
ke pelanggan lain.

Lab ini berperan sebagai Meta. Ia mengirim webhook WhatsApp Cloud API yang bentuknya sama persis dengan
aslinya ke bot yang berjalan di laptop kamu, sekaligus menyamar sebagai Graph API. Jadi pesan yang dikirim
bot tertangkap dan diperiksa. Tidak ada yang sampai ke WhatsApp sungguhan, selama semua jalur pengiriman bot
diarahkan ke mock dan bot memakai kredensial uji. Tanpa dependensi,
cukup Node.js 22+.

Bentuknya skill agent (`SKILL.md`) untuk Claude Code, Codex, Cursor, dan agent lain. Agent menyambungkan bot
ke mock, menjalankan lab, menjelaskan setiap kegagalan beserta buktinya, lalu membantu memperbaikinya. Lab
juga bisa dijalankan langsung dari command line atau di CI.

## Coba demonya

```bash
npm run demo:buggy   # bot dengan bug khas versi pertama: 5 dari 6 cek gagal
npm run demo:fixed   # bot yang sudah diperbaiki: semua lulus
```

## Mulai dengan bot kamu

1. Buat base URL Graph API di bot bisa diatur, misalnya
   `const GRAPH = process.env.GRAPH_API_URL ?? 'https://graph.facebook.com'`
   (lihat [references/setup.md](skill/whatsapp-bot-failure-lab/references/setup.md)).
2. Jalankan bot secara lokal dengan nilai uji:
   `GRAPH_API_URL=http://127.0.0.1:8788 WA_APP_SECRET=lab-secret WA_VERIFY_TOKEN=lab-verify npm start`
3. Jalankan lab:

```bash
node skill/whatsapp-bot-failure-lab/scripts/lab.mjs init
node skill/whatsapp-bot-failure-lab/scripts/lab.mjs run
```

Laporannya ada di `wa-lab-report/report.md`.

## Gratis vs Pro

Versi gratis di repo ini (MIT) berisi 6 cek dasar: preflight, handshake verifikasi, pesan dobel, webhook
status, payload rusak, dan kecepatan ack.

**Pro pack** di [Agensi](https://www.agensi.io) menambahkan 14 skenario:
- race pesan dobel;
- webhook berisi banyak pesan;
- tanda tangan palsu;
- kebocoran data antar pelanggan;
- tombol, media, dan pesan panjang;
- rate limit dan error permanen dari Graph API;
- status `failed` (jendela 24 jam);
- handoff ke admin;
- pesan basi dan pesan beruntun.

Pro pack juga dilengkapi pola perbaikan untuk Node.js, Python, dan Go.

## Batasan

- Hanya untuk bot berbasis **WhatsApp Cloud API**. Baileys, whatsmeow, whatsapp-web.js, dan gateway pihak
  ketiga belum didukung.
- Hanya untuk bot **lokal**. Jangan arahkan lab ke server production.
- Semua nomor telepon yang dibuat lab adalah nomor fiktif `1555…`. Jangan memasukkan percakapan pelanggan
  asli ke fixture atau laporan.

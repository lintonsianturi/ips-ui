# AMODA IPS Dimensi — ekstensi Trimble Connect

Panel samping untuk 3D Viewer Trimble Connect (versi browser). Saat panel IPS diklik di model, panel ini menampilkan:

- **Kode panel IPS** yang dibaca dari nama elemen IFC (`IPS/W/EXT/001`, `IPS_W_EXT_1`, `ips-w-int-t-27`, dan variasi serupa).
- **Ukuran katalog** dari 218 panel IPS (AI Design Process 10.xlsx).
- **Ukuran hasil ukur** dari kotak batas (bounding box) objek di viewer, plus status cocok / beda / kode tidak dikenal.
- **Kuantitas IFC** (Length, Width, Height, dst.) bila ikut diekspor.

Tombol **Tampilkan dimensi di 3D** menggambar garis ukur X, Y, Z dan label kode di model. Tab **Semua panel** memindai seluruh model, membuat daftar panel beserta statusnya, dan bisa diunduh sebagai CSV.

## 1. Coba tampilannya dulu (tanpa Trimble Connect)

Jalankan server lokal di folder ini, misalnya `python -m http.server 8000`, lalu buka `http://localhost:8000/index.html?demo`. Mode demo memakai data panel tiruan.

## 2. Hosting

Ekstensi harus bisa diakses lewat **HTTPS**. Pilihan paling mudah:

- **GitHub Pages**: buat repositori, unggah semua file di folder ini, aktifkan Pages (Settings › Pages). Alamatnya akan seperti `https://namaakun.github.io/ips-dimensi/`.
- **Netlify**: seret folder ini ke dashboard Netlify. File `_headers` sudah disiapkan agar manifest bisa dibaca Trimble Connect.

Setelah online, buka `manifest.json` dan ganti `GANTI-DENGAN-ALAMAT-ANDA` dengan alamat hosting Anda (untuk `icon` dan `url`), lalu unggah ulang.

## 3. Pasang di Trimble Connect

1. Buka proyek di Trimble Connect for Browser, lalu buka model IFC di **3D Viewer**.
2. Buka bagian **Extensions** pada viewer (atau Project Settings › Extensions), pilih tambah ekstensi kustom.
3. Tempel alamat lengkap `manifest.json`, misalnya `https://namaakun.github.io/ips-dimensi/manifest.json`.
4. Aktifkan ekstensinya. Panel **Dimensi Panel IPS** akan muncul di sisi viewer.

Nama menu di Trimble Connect bisa sedikit berbeda tergantung versi. Kalau tidak menemukannya, cek dokumentasi Trimble Connect tentang *custom extensions* / *Workspace API*.

## 4. Syarat data

Panel hanya dikenali kalau **nama elemen di IFC memuat kode IPS**. Kalau model dari SketchUp masih memakai nama lama, ganti nama komponennya dulu sebelum ekspor IFC.

## 5. Penyesuaian (bagian `CONFIG` di `app.js`)

| Setelan | Fungsi |
|---|---|
| `BBOX_UNIT` | Satuan kotak ukur dari viewer. `"auto"` menebak meter atau milimeter. |
| `MARKUP_UNIT` | Satuan koordinat garis dimensi 3D. Kalau garis muncul 1000× terlalu besar/kecil atau di lokasi yang salah, ganti `"mm"` ↔ `"m"`. |
| `TOLERANCE_MM` | Selisih maksimum yang masih dianggap cocok dengan katalog (default 5 mm). |
| `COLOR` | Warna garis dimensi 3D. |

## Batasan yang perlu diketahui

- **Kotak ukur mengikuti sumbu dunia.** Panel yang diputar miring (bukan kelipatan 90°) akan terukur lebih besar dari aslinya dan berstatus "beda".
- **Panel T** hanya dicek lebar dan tingginya, karena panjang kaki cabang tidak tercatat di katalog.
- **Atap gable/monoslope**: geometri IFC-nya sering tidak akurat; pakai angka katalog sebagai acuan.
- **Belum diuji langsung di Trimble Connect.** Nama fungsi Workspace API yang dipakai: `viewer.getSelection`, `viewer.getObjects`, `viewer.getObjectProperties`, `viewer.getObjectBoundingBoxes`, `viewer.setSelection`, `viewer.setCamera`, `markup.addMeasurementMarkups`, `markup.addTextMarkup`, `markup.removeMarkups`, dan event `viewer.onSelectionChanged`. Kalau muncul pesan "Fungsi API … tidak tersedia" di bilah status bawah, cocokkan nama tersebut dengan dokumentasi Workspace API versi terbaru.

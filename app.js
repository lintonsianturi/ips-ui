/* AMODA IPS Dimensi — ekstensi 3D Viewer Trimble Connect
 * Memakai Trimble Connect Workspace API. Nama fungsi API ditulis defensif (dicek dulu
 * sebelum dipanggil) karena bisa berubah antar versi — cek dokumentasi resmi bila ada error.
 */
(() => {
  "use strict";

  // ------------------------------------------------------------------ konfigurasi
  const CONFIG = {
    // Satuan bounding box dari viewer: "auto" menebak (m vs mm) dari besar angkanya.
    BBOX_UNIT: "auto",
    // Satuan koordinat untuk markup dimensi di 3D. Jika garis dimensi muncul 1000× terlalu
    // besar/kecil, ganti "mm" <-> "m".
    MARKUP_UNIT: "mm",
    TOLERANCE_MM: 5,
    MAX_CARDS: 25,
    BATCH: 200,
    COLOR: { r: 184, g: 98, b: 10, a: 255 },
  };

  const CAT = window.IPS_CATALOG || {};
  const $ = (id) => document.getElementById(id);
  let API = null;
  let selected = [];        // hasil analisis objek terpilih
  let scanned = [];         // hasil pindai semua panel
  let markupIds = [];
  let activeRow = -1;       // baris yang terakhir diklik di tab Semua panel

  // ------------------------------------------------------------------ util
  const fmt = (v) => (v == null || isNaN(v) ? "–" : String(Math.round(v)));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const has = (obj, path) => path.split(".").reduce((o, k) => (o ? o[k] : undefined), obj);
  const status = (msg, err = false) => { const el = $("status"); el.textContent = msg; el.classList.toggle("err", err); };

  async function call(path, ...args) {
    const parts = path.split(".");
    const fnName = parts.pop();
    const owner = parts.reduce((o, k) => (o ? o[k] : undefined), API);
    if (!owner || typeof owner[fnName] !== "function") throw new Error(`Fungsi API "${path}" tidak tersedia`);
    return owner[fnName](...args);
  }

  // ------------------------------------------------------------------ kode IPS
  // Mengenali "IPS/W/EXT/001", "IPS_W_EXT_1", "ips-w-int-t-27", "IPS W COR 002.ifc", dst.
  function parseCode(str) {
    if (typeof str !== "string" || !str) return null;
    const m = str.toUpperCase().match(/IPS(?:[\/_\-\\ .]+[A-Z0-9]+)+/);
    if (!m) return null;
    const parts = m[0].split(/[\/_\-\\ .]+/).filter(Boolean);
    if (/^(SKP|IFC|RVT|DWG|TRB)$/.test(parts[parts.length - 1])) parts.pop(); // ekstensi file
    const raw = parts.join("/");
    const lookup = (ps) => {
      for (let n = ps.length; n >= 3; n--) {
        const cand = ps.slice(0, n);
        const padded = cand.map((p) => (/^\d{1,2}$/.test(p) ? p.padStart(3, "0") : p));
        for (const c of [cand, padded]) if (CAT[c.join("/")]) return c.join("/");
      }
      return null;
    };
    let code = lookup(parts);
    // Nama file kadang punya segmen tambahan, mis. IPS_DW_DRW_EXT_001 -> katalog IPS/DW/DRW/001.
    // Coba buang satu segmen huruf (bukan IPS & kategori) bila tidak ketemu.
    for (let i = 2; !code && i < parts.length; i++) {
      if (/^[A-Z]+$/.test(parts[i])) code = lookup(parts.filter((_, j) => j !== i));
    }
    return { code, raw };
  }

  function collectStrings(obj, acc = [], depth = 0) {
    if (depth > 6 || obj == null) return acc;
    if (typeof obj === "string") { if (obj.length < 200) acc.push(obj); return acc; }
    if (Array.isArray(obj)) { obj.forEach((v) => collectStrings(v, acc, depth + 1)); return acc; }
    if (typeof obj === "object") Object.values(obj).forEach((v) => collectStrings(v, acc, depth + 1));
    return acc;
  }

  // Nama objek diprioritaskan; string lain hanya dipakai kalau menghasilkan kode katalog.
  function detectCode(props) {
    const names = [has(props, "product.name"), props?.name, has(props, "product.objectType")];
    let best = null;
    for (const s of names) {
      const r = parseCode(s);
      if (!r) continue;
      if (r.code) return r;
      best = best || r;
    }
    for (const s of collectStrings(props?.properties)) {
      const r = parseCode(s);
      if (r && r.code) return r;
    }
    return best;
  }

  // Kuantitas IFC (BaseQuantities / Pset) bila ikut diekspor.
  function ifcQuantities(props) {
    const out = {};
    const re = /^(length|width|height|depth|thickness|panjang|lebar|tinggi|tebal)$/i;
    (props?.properties || []).forEach((set) =>
      (set?.properties || []).forEach((p) => {
        const v = parseFloat(p?.value);
        if (p && re.test(p.name || "") && !isNaN(v) && out[p.name] == null) out[p.name] = v;
      })
    );
    return Object.keys(out).length ? out : null;
  }

  // ------------------------------------------------------------------ ukuran
  function bboxToMm(bb) {
    const min = bb.min, max = bb.max;
    const ext = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
    const unit = CONFIG.BBOX_UNIT === "auto" ? (ext < 60 ? "m" : "mm") : CONFIG.BBOX_UNIT;
    const k = unit === "m" ? 1000 : 1;
    const s = (p) => ({ x: p.x * k, y: p.y * k, z: p.z * k });
    const a = s(min), b = s(max);
    return { min: a, max: b, dx: b.x - a.x, dy: b.y - a.y, dz: b.z - a.z };
  }

  // Dimensi yang diharapkan muncul di kotak ukur. Panel T hanya punya lebar & tinggi di
  // katalog (kaki cabang tidak tercatat), jadi tebal tidak ikut dicek.
  function expectedDims(c) {
    if (/(^|\/)T$/.test(c.sub || "")) return [c.w, c.h].filter((v) => v != null);
    // Pintu/jendela: kusen & daun membuat tebal model > 90 mm, jadi hanya lebar & tinggi dicek.
    if (c.cat === "DOOR_WINDOW") return [c.w, c.h].filter((v) => v != null);
    const e = [c.w, c.l, c.h].filter((v) => v != null);
    if (e.length < 3 && c.t != null) e.push(c.t);
    return e;
  }

  // Setiap dimensi katalog harus punya pasangan berbeda di kotak ukur (selisih <= toleransi).
  function dimsMatch(expected, measured) {
    const pool = [...measured];
    return expected.every((v) => {
      const i = pool.findIndex((m) => Math.abs(m - v) <= CONFIG.TOLERANCE_MM);
      if (i < 0) return false;
      pool.splice(i, 1);
      return true;
    });
  }

  function judge(info, meas) {
    if (!info) return ["tanpa_kode", "Tanpa kode IPS"];
    const c = info.code && CAT[info.code];
    if (!c) return ["tidak_dikenal", "Kode tidak ada di katalog"];
    const e = expectedDims(c);
    if (!e.length || !meas) return ["cocok", "Ada di katalog"];
    return dimsMatch(e, [meas.dx, meas.dy, meas.dz]) ? ["cocok", "Cocok katalog"] : ["beda", "Beda dari katalog"];
  }

  async function analyze(modelId, ids) {
    const results = [];
    for (let i = 0; i < ids.length; i += CONFIG.BATCH) {
      const chunk = ids.slice(i, i + CONFIG.BATCH);
      const [props, boxes] = await Promise.all([
        call("viewer.getObjectProperties", modelId, chunk).catch(() => []),
        call("viewer.getObjectBoundingBoxes", modelId, chunk).catch(() => []),
      ]);
      const boxById = new Map((boxes || []).map((b) => [b.id, b.boundingBox || b]));
      (props || []).forEach((p) => {
        const info = detectCode(p);
        const bb = boxById.get(p.id);
        const meas = bb && bb.min && bb.max ? bboxToMm(bb) : null;
        const [st, label] = judge(info, meas);
        results.push({
          modelId, id: p.id, name: has(p, "product.name") || p.name || `Objek ${p.id}`,
          ifcClass: p.class || "", info, meas, st, label, qty: ifcQuantities(p),
        });
      });
    }
    return results;
  }

  // ------------------------------------------------------------------ panel = seluruh file
  // Model SketchUp per panel (mis. IPS_DW_DRW_EXT_001.skp) tidak punya kode di nama
  // elemennya; kodenya ada di nama file. Dalam kasus itu seluruh file dianggap satu panel
  // dan ukurannya diambil dari gabungan kotak ukur semua objek di file tersebut.
  const modelCache = new Map();

  function modelPanel(modelId) {
    if (!modelCache.has(modelId)) modelCache.set(modelId, (async () => {
      let name = "";
      try {
        const ms = await call("viewer.getModels");
        const m = (ms || []).find((x) => x.id === modelId || x.modelId === modelId);
        name = (m && (m.name || m.fileName)) || "";
      } catch (_) {}
      const info = parseCode(name);
      if (!info) return null;
      let ids = [];
      try {
        const all = await call("viewer.getObjects");
        const mo = (all || []).find((x) => x.modelId === modelId);
        ids = ((mo && mo.objects) || []).map((o) => o.id);
      } catch (_) {}
      let u = null;
      for (let i = 0; i < ids.length; i += CONFIG.BATCH) {
        const boxes = await call("viewer.getObjectBoundingBoxes", modelId, ids.slice(i, i + CONFIG.BATCH)).catch(() => []);
        (boxes || []).forEach((b) => {
          const bb = b.boundingBox || b;
          if (!bb || !bb.min || !bb.max) return;
          if (!u) u = { min: { ...bb.min }, max: { ...bb.max } };
          else ["x", "y", "z"].forEach((k) => {
            u.min[k] = Math.min(u.min[k], bb.min[k]);
            u.max[k] = Math.max(u.max[k], bb.max[k]);
          });
        });
      }
      const meas = u ? bboxToMm(u) : null;
      const [st, label] = judge(info, meas);
      return { modelId, id: null, ids, wholeModel: true, name, ifcClass: "seluruh file", info, meas, st, label, qty: null };
    })());
    return modelCache.get(modelId);
  }

  // ------------------------------------------------------------------ tampilan: terpilih
  // Satuan "mm" ditempel ke angka terakhir supaya tidak turun baris sendirian.
  function numList(pairs) {
    const items = pairs.filter(([, v]) => v != null);
    return items.map(([k, v], i) => `<span class="num"><small>${k}</small>${fmt(v)}${
      i === items.length - 1 ? '<span class="unit">mm</span>' : ""}</span>`).join("");
  }
  const catalogDims = (c) => numList([["W", c.w], ["L", c.l], ["H", c.h], ["t", c.t]]);

  function card(r) {
    const c = r.info && r.info.code && CAT[r.info.code];
    const tagText = r.info ? (r.info.code || r.info.raw) : "Tanpa kode IPS";
    const mark = { cocok: "✓ Cocok katalog", beda: "⚠ Beda dari katalog", tidak_dikenal: "? Tidak dikenal", tanpa_kode: "" }[r.st];
    let notes = "";
    if (r.st === "beda") {
      const roof = c && c.cat === "ROOF";
      notes = `<p class="note warn">${roof
        ? "Geometri atap di IFC sering tidak akurat. Pakai angka katalog sebagai acuan."
        : "Ukuran model tidak sama dengan katalog. Cek apakah panel diputar (kotak ukur mengikuti sumbu dunia) atau geometrinya keliru."}</p>`;
    }
    if (r.wholeModel) notes += `<p class="note">Kode dibaca dari nama file; ukuran = gabungan semua objek di file ini.</p>`;
    if (c && c.note) notes += `<p class="note">${esc(c.note)}</p>`;
    const qty = r.qty ? Object.entries(r.qty).map(([k, v]) => `<span class="num"><small>${esc(k)}</small>${esc(v)}</span>`).join("") : "";
    return `<article class="panel">
      <div class="panel-head">
          <span class="code-tag ${r.info ? "" : "none"}">${esc(tagText)}</span>
        <span class="pill ${r.st}">${mark}</span>
        <div class="panel-name">${esc(r.name)}${r.ifcClass ? ", " + esc(r.ifcClass) : ""}</div>
      </div>
      <dl class="dims">
        ${c ? `<dt>Katalog</dt><dd>${catalogDims(c)}</dd>` : ""}
        ${r.meas ? `<dt>Ukur</dt><dd>${numList([["X", r.meas.dx], ["Y", r.meas.dy], ["Z", r.meas.dz]])}</dd>` : `<dt>Ukur</dt><dd class="unit">Kotak ukur tidak tersedia</dd>`}
        ${qty ? `<dt>IFC</dt><dd>${qty}</dd>` : ""}
      </dl>${notes}
    </article>`;
  }

  function renderSelected() {
    const list = $("sel-list");
    if (!selected.length) {
      list.innerHTML = `<div class="empty"><strong>Belum ada panel terpilih</strong>Klik panel di model 3D untuk melihat kode dan ukurannya.</div>`;
      $("sel-actions").hidden = true;
      return;
    }
    const shown = selected.slice(0, CONFIG.MAX_CARDS);
    list.innerHTML = shown.map(card).join("") +
      (selected.length > shown.length ? `<p class="summary">+${selected.length - shown.length} objek lain tidak ditampilkan.</p>` : "");
    $("sel-actions").hidden = !selected.some((r) => r.meas);
  }

  async function onSelection(sel) {
    try {
      const groups = (sel || []).filter((g) => g && g.modelId && (g.objectRuntimeIds || []).length);
      if (!groups.length) { selected = []; renderSelected(); status("Siap. Klik panel di model."); return; }
      status("Membaca panel terpilih…");
      const all = [];
      let fromFile = 0;
      for (const g of groups) {
        const res = await analyze(g.modelId, g.objectRuntimeIds);
        if (!res.some((r) => r.info)) {
          const mp = await modelPanel(g.modelId);
          if (mp) { all.push(mp); fromFile++; if (res.length > 5) continue; } // banyak objek: cukup kartu file
        }
        all.push(...res);
      }
      selected = all;
      renderSelected();
      status(fromFile
        ? `Kode dari nama file (${groups.reduce((n, g) => n + g.objectRuntimeIds.length, 0)} objek terpilih).`
        : `${all.length} objek terpilih.`);
    } catch (e) { status(`Gagal membaca seleksi: ${e.message}`, true); }
  }

  // ------------------------------------------------------------------ markup dimensi 3D
  const toMarkup = (p) => {
    const k = CONFIG.MARKUP_UNIT === "m" ? 0.001 : 1;
    return { positionX: p.x * k, positionY: p.y * k, positionZ: p.z * k };
  };

  async function showDimensions() {
    const targets = selected.filter((r) => r.meas);
    if (!targets.length) return;
    $("btn-show").disabled = true;
    try {
      await clearDimensions(true);
      const lines = [], texts = [];
      targets.forEach((r) => {
        const { min: a, max: b } = r.meas;
        lines.push(
          { start: toMarkup(a), end: toMarkup({ x: b.x, y: a.y, z: a.z }), color: CONFIG.COLOR },
          { start: toMarkup(a), end: toMarkup({ x: a.x, y: b.y, z: a.z }), color: CONFIG.COLOR },
          { start: toMarkup({ x: b.x, y: a.y, z: a.z }), end: toMarkup({ x: b.x, y: a.y, z: b.z }), color: CONFIG.COLOR },
        );
        const top = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: b.z };
        const label = r.info ? (r.info.code || r.info.raw) : r.name;
        texts.push({
          start: toMarkup(top), end: toMarkup({ ...top, z: top.z + 400 }), color: CONFIG.COLOR,
          text: `${label}  ${fmt(r.meas.dx)} × ${fmt(r.meas.dy)} × ${fmt(r.meas.dz)} mm`,
        });
      });
      const added = await call("markup.addMeasurementMarkups", lines);
      markupIds.push(...(added || []).map((m) => m.id).filter((id) => id != null));
      try {
        const t = await call("markup.addTextMarkup", texts);
        markupIds.push(...(t || []).map((m) => m.id).filter((id) => id != null));
      } catch (_) { /* label teks opsional */ }
      status(`Dimensi ditampilkan untuk ${targets.length} objek.`);
    } catch (e) {
      status(`Gagal menggambar dimensi: ${e.message}`, true);
    } finally { $("btn-show").disabled = false; }
  }

  async function clearDimensions(silent = false) {
    if (!markupIds.length) { if (!silent) status("Tidak ada dimensi untuk dihapus."); return; }
    try {
      await call("markup.removeMarkups", markupIds);
      markupIds = [];
      if (!silent) status("Dimensi dihapus.");
    } catch (e) { status(`Gagal menghapus dimensi: ${e.message}`, true); }
  }

  // ------------------------------------------------------------------ pindai semua
  async function scanAll() {
    const btn = $("btn-scan");
    btn.disabled = true;
    try {
      status("Membaca daftar objek model…");
      const models = await call("viewer.getObjects");
      const out = [];
      let total = 0;
      for (const m of models || []) {
        const ids = (m.objects || []).map((o) => o.id);
        total += ids.length;
        status(`Memeriksa ${ids.length.toLocaleString("id-ID")} objek…`);
        const res = (await analyze(m.modelId, ids)).filter((r) => r.info);
        if (!res.length) { const mp = await modelPanel(m.modelId); if (mp) res.push(mp); }
        out.push(...res);
      }
      out.forEach((r, i) => (r.idx = i));
      scanned = out;
      activeRow = -1;
      renderRows();
      status(`Selesai: ${out.length} panel berkode IPS dari ${total.toLocaleString("id-ID")} objek.`);
    } catch (e) {
      status(`Gagal memindai: ${e.message}`, true);
    } finally { btn.disabled = false; }
  }

  function renderRows() {
    const f = $("filter").value;
    const rows = scanned.filter((r) => !f || r.st === f);
    const c = scanned.reduce((a, r) => ((a[r.st] = (a[r.st] || 0) + 1), a), {});
    $("summary").innerHTML = scanned.length
      ? `<b>${scanned.length}</b> panel. Cocok ${c.cocok || 0}, beda ${c.beda || 0}, tidak dikenal ${c.tidak_dikenal || 0}.`
      : "Tidak ditemukan panel berkode IPS. Pastikan nama elemen atau nama file memakai kode seperti IPS/W/EXT/001 atau IPS_W_EXT_001.";
    const icon = { cocok: "✓", beda: "⚠", tidak_dikenal: "?" };
    $("rows").innerHTML = rows.map((r) => `<li><button data-i="${r.idx}"${r.idx === activeRow ? ' aria-current="true"' : ""}>
        <span class="r-code">${esc(r.info.code || r.info.raw)}</span>
        <span class="r-st ${r.st}" title="${esc(r.label)}">${icon[r.st] || ""}</span>
        <span class="r-dims">${r.meas ? `${fmt(r.meas.dx)} × ${fmt(r.meas.dy)} × ${fmt(r.meas.dz)} mm` : "tanpa kotak ukur"}</span>
      </button></li>`).join("");
    $("all-actions").hidden = !scanned.length;
  }

  async function focusRow(i) {
    const r = scanned[i];
    if (!r) return;
    activeRow = i;
    document.querySelectorAll("#rows button").forEach((b) =>
      b.toggleAttribute("aria-current", +b.dataset.i === i));
    status(`Dipilih: ${r.info.code || r.info.raw}`);
    const selector = { modelObjectIds: [r.wholeModel ? { modelId: r.modelId, objectRuntimeIds: r.ids } : { modelId: r.modelId, objectRuntimeIds: [r.id] }] };
    try {
      await call("viewer.setSelection", selector, "set");
      await call("viewer.setCamera", selector, { animationTime: 400 }).catch(() => {});
    } catch (e) { status(`Tidak bisa memilih objek: ${e.message}`, true); }
  }

  function tableText(sep) {
    const head = ["Kode", "Nama", "Katalog_W", "Katalog_L", "Katalog_H", "Katalog_t", "Ukur_X", "Ukur_Y", "Ukur_Z", "Status"];
    const lines = [head.join(sep)];
    scanned.forEach((r) => {
      const c = (r.info.code && CAT[r.info.code]) || {};
      const m = r.meas || {};
      lines.push([r.info.code || r.info.raw, r.name, c.w, c.l, c.h, c.t,
        m.dx && Math.round(m.dx), m.dy && Math.round(m.dy), m.dz && Math.round(m.dz), r.label]
        .map((v) => String(v ?? "").replaceAll(sep, " ")).join(sep));
    });
    return lines.join("\r\n");
  }

  function downloadCsv() {
    const blob = new Blob(["\uFEFF" + tableText(";")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dimensi_panel_ips.csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    status("CSV diunduh. Kalau tidak muncul, pakai Salin tabel lalu tempel ke Excel.");
  }

  async function copyTable() {
    try { await navigator.clipboard.writeText(tableText("\t")); status("Tabel disalin. Tempel ke Excel."); }
    catch (_) { status("Browser menolak akses clipboard. Pakai Unduh CSV.", true); }
  }

  // ------------------------------------------------------------------ tab & event UI
  function switchView(v) {
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === v)));
    $("view-sel").hidden = v !== "sel";
    $("view-all").hidden = v !== "all";
  }
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
  $("btn-show").addEventListener("click", showDimensions);
  $("btn-clear").addEventListener("click", () => clearDimensions());
  $("btn-scan").addEventListener("click", scanAll);
  $("filter").addEventListener("change", renderRows);
  $("rows").addEventListener("click", (e) => { const b = e.target.closest("button[data-i]"); if (b) focusRow(+b.dataset.i); });
  $("btn-csv").addEventListener("click", downloadCsv);
  $("btn-copy").addEventListener("click", copyTable);

  // ------------------------------------------------------------------ koneksi
  function onEvent(event, args) {
    if (event === "viewer.onSelectionChanged") onSelection(args && args.data);
  }

  async function connect() {
    renderSelected();
    if (new URLSearchParams(location.search).has("demo")) { API = window.IPSDemoAPI(onEvent); }
    else {
      if (!window.TrimbleConnectWorkspace || window.parent === window) {
        status("Buka halaman ini sebagai ekstensi di 3D Viewer Trimble Connect (atau tambahkan ?demo untuk mencoba).", true);
        return;
      }
      API = await window.TrimbleConnectWorkspace.connect(window.parent, onEvent, 30000);
    }
    if (!API || !API.viewer) {
      status("Terhubung, tapi API 3D Viewer tidak tersedia. Pasang ekstensi ini di 3D Viewer, bukan di halaman proyek.", true);
      return;
    }
    status("Siap. Klik panel di model.");
    try { onSelection(await call("viewer.getSelection")); } catch (_) {}
  }

  // ------------------------------------------------------------------ mode demo (?demo)
  // API tiruan supaya tampilan bisa dicoba di browser biasa tanpa Trimble Connect.
  window.IPSDemoAPI = (emit) => {
    const objs = [
      { id: 1, name: "IPS_W_EXT_001", bb: [0, 0, 0.1, 1.2, 0.09, 2.5] },
      { id: 2, name: "IPS/W/COR/002", bb: [1.2, 0, 0.1, 1.8, 0.6, 2.5] },
      { id: 3, name: "IPS-W-INT-T-27", bb: [3, 1, 0.1, 4.2, 2.11, 2.5] },
      { id: 4, name: "IPS/FL/016", bb: [0, 0, 0, 6, 6, 0.1] },
      { id: 5, name: "IPS/R/GABLE/B/019", bb: [-0.3, -0.3, 2.5, 11.4, 12.6, 6.9] },
      { id: 6, name: "IPS/W/EXT/099", bb: [5, 0, 0.1, 6.2, 0.09, 2.5] },
    ];
    const find = (ids) => objs.filter((o) => ids.includes(o.id));
    let n = 0;
    setTimeout(() => emit("viewer.onSelectionChanged", { data: [{ modelId: "demo", objectRuntimeIds: [1, 2, 5] }] }), 300);
    return {
      viewer: {
        getSelection: async () => [],
        getObjects: async () => [{ modelId: "demo", objects: objs.map((o) => ({ id: o.id })) }],
        getObjectProperties: async (_m, ids) => find(ids).map((o) => ({ id: o.id, class: "IfcBuildingElementProxy", product: { name: o.name }, properties: [] })),
        getObjectBoundingBoxes: async (_m, ids) => find(ids).map((o) => ({ id: o.id, boundingBox: { min: { x: o.bb[0], y: o.bb[1], z: o.bb[2] }, max: { x: o.bb[3], y: o.bb[4], z: o.bb[5] } } })),
        setSelection: async () => {}, setCamera: async () => {},
      },
      markup: {
        addMeasurementMarkups: async (m) => m.map((x) => ({ ...x, id: ++n })),
        addTextMarkup: async (m) => m.map((x) => ({ ...x, id: ++n })),
        removeMarkups: async () => {},
      },
    };
  };

  connect().catch((e) => status(`Gagal terhubung ke Trimble Connect: ${e.message}`, true));
})();

/** Parseo e importación del reporte CSV público de Syscom (enlace automático). */

const CHUNK = 3000;

function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normHeader(h) {
  return String(h || "")
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** CSV con comillas, comas y saltos de línea dentro de campos. */
function parseCsv(text) {
  const src = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inQuotes) {
      if (c === '"' && n === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (c === "\n" || (c === "\r" && n === "\n")) {
      if (c === "\r") i++;
      row.push(field);
      field = "";
      if (row.some((x) => String(x).trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    if (c === "\r") {
      row.push(field);
      field = "";
      if (row.some((x) => String(x).trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  row.push(field);
  if (row.some((x) => String(x).trim() !== "")) rows.push(row);
  return rows;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && String(obj[k]).trim() !== "") return String(obj[k]).trim();
  }
  return "";
}

function parsePrice(raw) {
  let s = String(raw || "").trim();
  if (!s) return 0;
  s = s.replace(/[^0-9,.\-]/g, "");
  if (s.includes(",") && s.includes(".")) {
    // 1,234.56 o 1.234,56
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (s.includes(",")) {
    // 1234,56 → decimal
    if (/,\d{1,2}$/.test(s)) s = s.replace(",", ".");
    else s = s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function mapCsvRows(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map(normHeader);
  const idx = {};
  headers.forEach((h, i) => {
    if (h && idx[h] == null) idx[h] = i;
  });

  const get = (cells, aliases) => {
    for (const a of aliases) {
      if (idx[a] != null) return cells[idx[a]] != null ? String(cells[idx[a]]) : "";
    }
    return "";
  };

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells || !cells.length) continue;

    const sku = get(cells, [
      "modelo", "modelo_sin_guion", "model", "sku", "clave", "codigo", "codigo_producto",
      "id_producto", "producto_id", "part_number", "no_parte"
    ]).trim();
    if (!sku) continue;

    let desc = stripHtml(get(cells, [
      "titulo", "descripcion", "descripcion_html", "description", "nombre", "name", "producto", "desc"
    ]));
    if (!desc) desc = sku;

    const brand = get(cells, ["marca", "brand", "fabricante", "trademark"]).trim() || "SYSCOM";
    const category = get(cells, [
      "categorias", "categoria", "category", "categories", "linea", "id_categorias"
    ]).trim() || "Syscom";

    const price = parsePrice(get(cells, [
      "precio_descuento", "precio_1", "precio_distribuidor", "precio_lista",
      "precio", "price", "costo", "precio_usd", "precio_mxn"
    ]));
    if (!(price > 0)) continue;

    let curr = get(cells, ["moneda", "currency", "currency_code"]).toUpperCase();
    if (!curr) {
      const tc = get(cells, ["tipo_de_cambio", "tipo_cambio", "exchange_rate"]);
      curr = tc ? "USD" : "USD";
    }
    if (/MX|PESO|MN/.test(curr)) curr = "MXN";
    else if (/US|DOL/.test(curr)) curr = "USD";
    else curr = "USD";

    let satCode = get(cells, ["sat", "clave_sat", "codigo_sat", "sat_code", "clavesat"]).replace(/\D/g, "");
    if (!/^\d{8}$/.test(satCode)) satCode = "46171610";
    const satDesc = get(cells, ["descripcion_sat", "sat_desc", "satdesc"]).trim() || category;

    out.push({
      store: "Syscom",
      category,
      sku,
      brand,
      desc,
      rawPrice: Math.round(price * 10000) / 10000,
      currency: curr,
      satCode,
      satDesc
    });
  }
  return out;
}

function validateSyscomUrl(url) {
  let u;
  try {
    u = new URL(String(url || "").trim());
  } catch (e) {
    return "URL inválida";
  }
  if (u.protocol !== "https:") return "El enlace debe ser https://";
  if (!/(^|\.)syscom\.mx$/i.test(u.hostname)) return "El enlace debe ser de syscom.mx";
  if (!/reportes-csv/i.test(u.pathname)) {
    return "Usa el enlace de «Descarga automática» del reporte CSV (ruta reportes-csv/publico/…)";
  }
  return "";
}

async function fetchSyscomCsv(url, signal) {
  const err = validateSyscomUrl(url);
  if (err) throw new Error(err);
  const r = await fetch(String(url).trim(), {
    method: "GET",
    headers: {
      Accept: "text/csv,text/plain,application/octet-stream,*/*",
      "User-Agent": "GASO-Ingenieria-CatalogSync/1.0"
    },
    redirect: "follow",
    signal
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error("Syscom HTTP " + r.status + ": " + String(text).replace(/\s+/g, " ").slice(0, 160));
  }
  if (!text || text.length < 40) throw new Error("Syscom devolvió un archivo vacío.");
  if (/^\s*</.test(text) || /<html/i.test(text.slice(0, 200))) {
    throw new Error("Syscom devolvió HTML en lugar de CSV (enlace vencido o límite 1/hora). Regenera o reintenta más tarde.");
  }
  return text;
}

async function saveCatalogParts(db, name, products) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS gaso_catalog_parts (
      name TEXT NOT NULL, part INTEGER NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (name, part)
    )`
  ).run();
  await db.prepare("DELETE FROM gaso_catalog_parts WHERE name = ?1").bind(name).run();
  let parts = 0;
  for (let i = 0; i < products.length; i += CHUNK) {
    const slice = products.slice(i, i + CHUNK);
    await db
      .prepare(
        `INSERT INTO gaso_catalog_parts (name, part, n, data) VALUES (?1, ?2, ?3, ?4)`
      )
      .bind(name, parts, slice.length, JSON.stringify(slice))
      .run();
    parts++;
  }
  return { total: products.length, parts };
}

export {
  CHUNK,
  parseCsv,
  mapCsvRows,
  validateSyscomUrl,
  fetchSyscomCsv,
  saveCatalogParts,
  stripHtml,
  pick
};
export default {
  CHUNK,
  parseCsv,
  mapCsvRows,
  validateSyscomUrl,
  fetchSyscomCsv,
  saveCatalogParts
};

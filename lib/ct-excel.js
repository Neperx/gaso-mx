/**
 * Parser de lista de precios CT Internacional (.xlsx).
 * Columna "m" = MXN; sin "m" = USD (como en el Excel oficial).
 */

const SHEET_CAT = {
  "COMPONENTES DE ENSAMBLE": 0,
  "EQUIPOS DE MARCA": 1,
  "IMPRESION, DIG. DE IMAGENES": 2,
  "CONSUMIBLES": 3,
  "CONECTIVIDAD": 4,
  "TELEFONIA Y VIDEO VIGILANCIA": 5,
  "ELECTRONICA DE CONSUMO": 6,
  "LINEA BLANCA": 7,
  "PUNTO DE VENTA": 8,
  "SOFTWARE": 9,
  "ACCESORIOS": 10,
  "ENERGIA": 11,
  "OUTLET": 12,
  "OUTLET EQUIPOS DE MARCA": 12
};

const CAT_NAMES = [
  "Componentes y Ensamble", "Cómputo y Laptops", "Impresión y Escáneres", "Consumibles y Tintas",
  "Redes y Conectividad", "Telefonía y Videovigilancia", "Electrónica y Pantallas", "Línea Blanca y Clima",
  "Punto de Venta (POS)", "Software y Licencias", "Accesorios y Periféricos", "Energía, UPS y Reguladores",
  "Outlet y Liquidación"
];

function brandFrom(sku, desc) {
  const u = String(sku + " " + desc).toUpperCase();
  const rules = [
    [/INTEL|CPUINT/, "Intel"], [/AMD|RYZEN|CPUAMD/, "AMD"], [/KINGSTON|MEMKGN/, "Kingston"],
    [/ADATA|XPG|MEMDAT|DDUDAT/, "ADATA"], [/SAMSUNG|MONSMG/, "Samsung"], [/(\bLG\b|MONLGE)/, "LG"],
    [/ASUS|MBDASS|TVIASS/, "ASUS"], [/GIGABYTE|MBDGIG/, "Gigabyte"], [/APPLE|MACBOOK|COMMAC|IPDMAC/, "Apple"],
    [/DELL|COMDDL|MONDLL/, "Dell"], [/(\bHP\b|CPUHPI|IMPHPI|CARHPD)/, "HP"], [/LENOVO|COMLEV|CPULEV/, "Lenovo"],
    [/EPSON|IMPEPS|CAREPS/, "Epson"], [/BROTHER|IMPBRT|CARBRT/, "Brother"], [/CANON|IMPCNN/, "Canon"],
    [/WESTERN DIGITAL|\bWD\b/, "Western Digital"], [/SEAGATE/, "Seagate"], [/TP-?LINK|TARTPL/, "TP-Link"],
    [/TRIPP|REGTRL/, "Tripp Lite"], [/APC\b/, "APC"], [/CISCO/, "Cisco"]
  ];
  for (const [re, b] of rules) if (re.test(u)) return b;
  return "CT";
}

function satFor(catIdx) {
  const map = ["43211500", "43211500", "43212100", "44103100", "43222600", "46171610", "52161500", "52141500", "43212100", "43231500", "43211600", "39121000", "43211500"];
  return map[catIdx] || "43211500";
}

/** rows: array of sheet arrays from SheetJS sheet_to_json({header:1}) */
function parseCtSheetRows(sheetName, rows) {
  const catIdx = SHEET_CAT[sheetName];
  if (catIdx == null || !rows || !rows.length) return [];
  const out = [];
  for (const r of rows) {
    const cells = Array.isArray(r) ? r : [];
    let sku = "", desc = "", price = 0, isMxn = false;
    for (let i = 0; i < cells.length; i++) {
      const v = cells[i];
      if (typeof v === "string" && v.trim().toLowerCase() === "m") isMxn = true;
    }
    for (let i = 0; i < cells.length; i++) {
      const v = String(cells[i] == null ? "" : cells[i]).trim();
      if (!v || /^ver ficha$/i.test(v)) continue;
      if (!/^[A-Z0-9][A-Z0-9\-_\/]{4,24}$/i.test(v)) continue;
      if (/^(clave|similar|precio|ficha)$/i.test(v)) continue;
      let p = null;
      for (let j = i + 1; j < Math.min(cells.length, i + 8); j++) {
        if (typeof cells[j] === "number" && cells[j] > 0) { p = cells[j]; break; }
        const n = parseFloat(String(cells[j]).replace(/[^0-9.]/g, ""));
        if (n > 0 && String(cells[j]).replace(/[^0-9.]/g, "").length >= 1) { p = n; break; }
      }
      if (!(p > 0)) continue;
      sku = v;
      desc = String(cells[i + 1] || "").trim();
      if (desc.length < 6) desc = String(cells[i + 2] || desc).trim();
      price = p;
      break;
    }
    if (!sku || !(price > 0)) continue;
    const brand = brandFrom(sku, desc);
    out.push({
      store: "CT Internacional",
      category: CAT_NAMES[catIdx] || "General",
      sku,
      brand,
      desc: desc || sku,
      rawPrice: Math.round(price * 10000) / 10000,
      currency: isMxn ? "MXN" : "USD",
      satCode: satFor(catIdx),
      satDesc: CAT_NAMES[catIdx] || "Equipo de cómputo"
    });
  }
  return out;
}

/** Compact tuple format used historically in D1 for CT */
function toCtTuple(p) {
  const catIdx = CAT_NAMES.indexOf(p.category);
  return [
    catIdx >= 0 ? catIdx : 0,
    p.sku,
    p.brand,
    p.desc,
    p.rawPrice,
    p.currency === "MXN" ? 1 : 0,
    p.satCode,
    p.satDesc
  ];
}

export { SHEET_CAT, CAT_NAMES, parseCtSheetRows, toCtTuple, brandFrom };
export default { SHEET_CAT, CAT_NAMES, parseCtSheetRows, toCtTuple };

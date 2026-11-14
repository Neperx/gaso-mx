/**
 * Importa la lista CT .xlsx a D1 (gaso_catalog_parts name=ct) vía wrangler.
 * Uso: node scripts/import-ct-excel.mjs "RUTA\archivo.xlsx"
 */
import { writeFileSync, unlinkSync } from "fs";
import { execFileSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

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
const CAT_SAT = ["43201503","43211500","43212100","44103100","43222600","46171610","52161500","52141500","43212100","43231500","43211600","39121000","43211500"];
const CAT_DESC = ["Componentes","Cómputo","Impresión","Consumibles","Redes","Videovigilancia","Electrónica","Línea blanca","POS","Software","Accesorios","Energía","Outlet"];

function brandFrom(sku, desc) {
  const u = (sku + " " + desc).toUpperCase();
  const rules = [
    [/INTEL|CPUINT/, "Intel"], [/AMD|RYZEN|CPUAMD/, "AMD"], [/KINGSTON|MEMKGN/, "Kingston"],
    [/ADATA|XPG|MEMDAT/, "ADATA"], [/SAMSUNG|MONSMG/, "Samsung"], [/(\bLG\b|MONLGE)/, "LG"],
    [/ASUS|MBDASS/, "ASUS"], [/GIGABYTE|MBDGIG/, "Gigabyte"], [/APPLE|MACBOOK|COMMAC/, "Apple"],
    [/DELL|COMDDL/, "Dell"], [/(\bHP\b|CPUHPI|IMPHPI|CARHPD)/, "HP"], [/LENOVO|COMLEV/, "Lenovo"],
    [/EPSON|IMPEPS/, "Epson"], [/BROTHER/, "Brother"], [/CANON/, "Canon"], [/TP-?LINK|TARTPL/, "TP-Link"],
    [/TRIPP|REGTRL/, "Tripp Lite"], [/APC\b/, "APC"]
  ];
  for (const [re, b] of rules) if (re.test(u)) return b;
  return "CT";
}

function parseSheet(name, rows) {
  const cat = SHEET_CAT[name];
  if (cat == null) return [];
  const out = [];
  for (const r of rows) {
    const cells = Array.isArray(r) ? r : [];
    let isMxn = cells.some((c) => String(c || "").trim().toLowerCase() === "m");
    let sku = "", desc = "", price = 0;
    for (let i = 0; i < cells.length; i++) {
      const v = String(cells[i] ?? "").trim();
      if (!/^[A-Z0-9][A-Z0-9\-_\/]{4,24}$/i.test(v) || /^ver ficha$/i.test(v)) continue;
      let p = null;
      for (let j = i + 1; j < Math.min(cells.length, i + 8); j++) {
        if (typeof cells[j] === "number" && cells[j] > 0) { p = cells[j]; break; }
      }
      if (!(p > 0)) continue;
      sku = v;
      desc = String(cells[i + 1] || "").trim();
      if (desc.length < 6) desc = String(cells[i + 2] || desc).trim();
      price = p;
      break;
    }
    if (!sku || !(price > 0)) continue;
    out.push([
      cat,
      sku,
      brandFrom(sku, desc),
      (desc || sku).slice(0, 280),
      Math.round(price * 100) / 100,
      isMxn ? 1 : 0,
      CAT_SAT[cat] || "43211500",
      CAT_DESC[cat] || "General"
    ]);
  }
  return out;
}

const xlsxPath = process.argv[2];
if (!xlsxPath) {
  console.error("Uso: node scripts/import-ct-excel.mjs \"ruta\\lista.xlsx\"");
  process.exit(1);
}

const wb = XLSX.readFile(xlsxPath, { cellDates: true });
let all = [];
for (const name of Object.keys(SHEET_CAT)) {
  if (!wb.Sheets[name]) continue;
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" });
  const part = parseSheet(name, rows);
  console.log(name, part.length);
  all = all.concat(part);
}
const map = new Map();
all.forEach((t) => map.set(t[1], t));
all = [...map.values()];
console.log("TOTAL únicos", all.length);

// Un solo archivo con muchos INSERT pequeños (1 upload a D1)
const CHUNK = 60;
let sql = "CREATE TABLE IF NOT EXISTS gaso_catalog_parts (name TEXT NOT NULL, part INTEGER NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (name, part));\n";
sql += "DELETE FROM gaso_catalog_parts WHERE name = 'ct';\n";
for (let i = 0, p = 0; i < all.length; i += CHUNK, p++) {
  const slice = all.slice(i, i + CHUNK);
  const json = JSON.stringify(slice).replace(/'/g, "''");
  sql += `INSERT INTO gaso_catalog_parts (name, part, n, data) VALUES ('ct', ${p}, ${slice.length}, '${json}');\n`;
}
const sqlFile = "_ct_all.sql";
writeFileSync(join(root, sqlFile), sql, "utf8");
console.log("SQL", sqlFile, "bytes", sql.length, "parts", Math.ceil(all.length / CHUNK));
try {
  execFileSync("npx", ["wrangler", "d1", "execute", "gaso-db", "--remote", "--file", sqlFile, "--yes"], {
    cwd: root,
    stdio: "inherit",
    shell: true,
    windowsHide: true
  });
  console.log("CT importado a D1 OK");
} finally {
  try { unlinkSync(join(root, sqlFile)); } catch (e) { /* ignore */ }
}

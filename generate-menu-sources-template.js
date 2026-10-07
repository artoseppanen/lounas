/**
 * generate-menu-sources-template.js
 *
 * Hakee kaikki Tampereen ravintolat/kahvilat/pikaruokapaikat Overpassista
 * (SAMA kysely ja SAMA aluerajaus jota index.html jo käyttää) ja kirjoittaa
 * menu-sources.csv -tiedoston valmiiksi restaurant_id + name -sarakkeilla.
 * Sinulle jää täytettäväksi vain "url"-sarake niille ravintoloille joilta
 * löydät parsittavan (ei-PDF) lounaslistan.
 *
 * HUOM: en pysty ajamaan tätä itse tässä keskustelussa, koska tämän
 * ympäristön verkkoyhteys ei pääse Overpassiin (sama rajoitus josta on
 * puhuttu koko keskustelun ajan). Aja tämä omalla koneellasi, jolla on
 * tavallinen internetyhteys.
 *
 * Käyttö:
 *   node generate-menu-sources-template.js
 *   (vaatii Node.js 18 tai uudemman, jossa fetch on sisäänrakennettu)
 *
 * Jos tiedosto menu-sources.csv on jo olemassa ja sisältää täytettyjä
 * url-rivejä, tämä EI ylikirjoita niitä — se yhdistää: säilyttää olemassa
 * olevat url/platform/active/notes-arvot samalla restaurant_id:llä, ja
 * lisää uudet Overpassista löytyvät ravintolat tyhjillä sarakkeilla.
 */

const fs = require("fs");

const TAMPERE_BBOX = "61.435,23.640,61.560,23.900";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OUTPUT_FILE = "menu-sources.csv";

function buildQuery(bbox) {
  return `[out:json][timeout:60];
(
  node["amenity"~"^(restaurant|cafe|fast_food)$"](${bbox});
  way["amenity"~"^(restaurant|cafe|fast_food)$"](${bbox});
  relation["amenity"~"^(restaurant|cafe|fast_food)$"](${bbox});
);
out center tags;`;
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Sama minimaalinen CSV-jäsennin kuin import-menu-sources.js:ssä, jotta
// osaamme lukea mahdollisen olemassa olevan tiedoston ja säilyttää sen
// täytetyt url/platform/active/notes-arvot.
function splitCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) { result.push(current); current = ""; }
    else current += ch;
  }
  result.push(current);
  return result;
}

function loadExisting(path) {
  if (!fs.existsSync(path)) return {};
  const lines = fs.readFileSync(path, "utf-8").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return {};
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const byId = {};
  for (const line of lines.slice(1)) {
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => (row[h] = (values[i] || "").trim()));
    if (row.restaurant_id) byId[row.restaurant_id] = row;
  }
  return byId;
}

async function main() {
  console.log("Haetaan Tampereen ravintolat Overpassista...");

  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "User-Agent": "TampereenLounasScript/1.0 (henkilokohtainen projekti, ei tuotantokayttoa)",
    },
    body: "data=" + encodeURIComponent(buildQuery(TAMPERE_BBOX)),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json();

  const found = data.elements
    .map((el) => ({
      id: `${el.type}/${el.id}`,
      name: (el.tags && el.tags.name) || "Nimetön kohde",
    }))
    .filter((r) => r.name !== "Nimetön kohde") // nimettömät eivät ole hyödyllisiä listassa
    .sort((a, b) => a.name.localeCompare(b.name, "fi"));

  console.log(`Löytyi ${found.length} nimettyä ravintolaa/kahvilaa/pikaruokapaikkaa.`);

  const existing = loadExisting(OUTPUT_FILE);
  let keptCount = 0;
  let newCount = 0;

  const rows = found.map((r) => {
    const prev = existing[r.id];
    if (prev && (prev.url || prev.notes)) keptCount++;
    else newCount++;
    return {
      restaurant_id: r.id,
      name: r.name,
      url: prev ? prev.url || "" : "",
      platform: prev ? prev.platform || "" : "",
      active: prev ? prev.active || "FALSE" : "FALSE",
      pdf_url_pattern: prev ? prev.pdf_url_pattern || "" : "",
      notes: prev ? prev.notes || "" : "",
    };
  });

  const header = "restaurant_id,name,url,platform,active,pdf_url_pattern,notes";
  const lines = rows.map((r) =>
    [r.restaurant_id, r.name, r.url, r.platform, r.active, r.pdf_url_pattern, r.notes].map(csvEscape).join(",")
  );
  fs.writeFileSync(OUTPUT_FILE, [header, ...lines].join("\n") + "\n", "utf-8");

  console.log(`\nKirjoitettu ${OUTPUT_FILE}: ${rows.length} riviä`);
  console.log(`  - ${keptCount} riviä joissa oli jo täytetty url/notes -> säilytetty ennallaan`);
  console.log(`  - ${newCount} uutta riviä tyhjällä url-sarakkeella täytettäväksi`);
  console.log(`\nSeuraava askel: avaa ${OUTPUT_FILE}, etsi rivit joilla on lounaslista,`);
  console.log(`täytä niiden url-sarake, ja aseta active=TRUE. Muut voi jättää ennalleen.`);
}

main().catch((err) => {
  console.error("Haku epäonnistui:", err);
  process.exit(1);
});

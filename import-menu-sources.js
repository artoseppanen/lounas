/**
 * import-menu-sources.js
 *
 * Lukee menu-sources.csv -tiedoston ja kirjoittaa/päivittää jokaisen rivin
 * menuSources/{restaurant_id} -dokumentiksi Firestoreen.
 *
 * Käyttö:
 *   npm install firebase-admin
 *   node import-menu-sources.js menu-sources.csv
 *
 * Vaatii palvelutilin avaimen samassa kansiossa nimellä serviceAccountKey.json
 * (Firebase Console -> Project settings -> Service accounts -> Generate new
 * private key). ÄLÄ committaa tätä avainta versionhallintaan.
 */

const fs = require("fs");
const path = require("path");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("Käyttö: node import-menu-sources.js polku/tiedostoon.csv");
  process.exit(1);
}

const keyPath = path.join(__dirname, "serviceAccountKey.json");
if (!fs.existsSync(keyPath)) {
  console.error(
    "serviceAccountKey.json puuttuu. Lataa se Firebase Consolesta:\n" +
    "Project settings -> Service accounts -> Generate new private key."
  );
  process.exit(1);
}

initializeApp({ credential: cert(require(keyPath)) });
const db = getFirestore();

// Pieni, riippuvuudeton CSV-jäsennin joka osaa lainausmerkein ympäröidyt
// kentät (esim. muistiinpanot joissa on pilkkuja). Riittää tähän tarpeeseen,
// ei ole yleiskäyttöinen RFC4180-toteutus.
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => (row[h.trim()] = (values[i] || "").trim()));
    return row;
  });
}

// Firestore ei salli "/"-merkkiä dokumentin ID:ssä (OSM:n id:t ovat muotoa
// "node/12345"). Muunnetaan automaattisesti "node_12345"-muotoon, alkuperäinen
// säilytetään erillisenä restaurantId-kenttänä dokumentin sisällä.
function sanitizeId(id) {
  return String(id).replace(/\//g, "_");
}

function splitCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

async function main() {
  const text = fs.readFileSync(csvPath, "utf-8");
  const rows = parseCsv(text);

  console.log(`Luettu ${rows.length} riviä tiedostosta ${csvPath}\n`);

  let ok = 0;
  let skipped = 0;

  for (const row of rows) {
    const restaurantId = row.restaurant_id;
    if (!restaurantId || restaurantId.includes("REPLACE_WITH")) {
      console.warn(`OHITETTU (puuttuva/täyttämätön restaurant_id): ${row.name || row.url}`);
      skipped++;
      continue;
    }
    if (!row.url) {
      console.warn(`OHITETTU (url puuttuu): ${restaurantId}`);
      skipped++;
      continue;
    }

    await db.collection("menuSources").doc(sanitizeId(restaurantId)).set(
      {
        restaurantId: restaurantId, // alkuperäinen "node/12345"-muoto talteen
        name: row.name || "",
        url: row.url,
        platform: row.platform || null,
        active: String(row.active).trim().toUpperCase() === "TRUE",
        pdfUrlPattern: row.pdf_url_pattern || null,
        notes: row.notes || "",
        importedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    console.log(`OK: ${restaurantId} (${row.name || "nimetön"})`);
    ok++;
  }

  console.log(`\nValmis. ${ok} vietiin, ${skipped} ohitettiin.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Tuonti epäonnistui:", err);
  process.exit(1);
});

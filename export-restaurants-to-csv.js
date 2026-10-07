/**
 * export-restaurants-to-csv.js
 *
 * Hakee kaikki ravintolat Firestoren restaurants-kokoelmasta ja kirjoittaa
 * ne CSV-tiedostoon: restaurant_id, name, website. Tarkoitus on että käyt
 * tämän listan läpi, etsit kunkin ravintolan OIKEAN lounaslista-osoitteen
 * (joka on usein eri kuin verkkosivusto-osoite), ja syötät sen manuaalisesti
 * menu-sources.csv:hen.
 *
 * Käyttö:
 *   node export-restaurants-to-csv.js
 *
 * Vaatii serviceAccountKey.json samassa kansiossa (sama avain kuin
 * import-menu-sources.js:lle ja reset-ratings.js:lle).
 *
 * Avaa tuloksena syntyvä restaurants-export.csv Excelissä/Sheetsissä.
 */

const fs = require("fs");
const path = require("path");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

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

const OUTPUT_FILE = "restaurants-export.csv";

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

async function main() {
  console.log("Haetaan ravintolat Firestoresta...");
  const snap = await db.collection("restaurants").get();
  console.log(`Löytyi ${snap.size} ravintolaa.`);

  const rows = snap.docs
    .map((doc) => {
      const data = doc.data();
      return {
        // Käytetään dokumentin OMAA "id"-kenttää (alkuperäinen "node/12345"
        // -muoto), ei Firestore-dokumentin sanitoitua ID:tä.
        restaurant_id: data.id || doc.id,
        name: data.name || "",
        website: data.website || "",
      };
    })
    // Järjestetään aakkosjärjestykseen, helpottaa läpikäyntiä.
    .sort((a, b) => a.name.localeCompare(b.name, "fi"));

  const withWebsite = rows.filter((r) => r.website).length;
  console.log(`Näistä ${withWebsite} ravintolalla on verkkosivusto-osoite, ${rows.length - withWebsite} ei.`);

  const header = "restaurant_id,name,website";
  const lines = rows.map((r) =>
    [r.restaurant_id, r.name, r.website].map(csvEscape).join(",")
  );
  fs.writeFileSync(OUTPUT_FILE, [header, ...lines].join("\n") + "\n", "utf-8");

  console.log(`\nKirjoitettu ${OUTPUT_FILE} (${rows.length} riviä).`);
  console.log("Avaa se Excelissä/Sheetsissä ja käy verkkosivustot läpi.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Vienti epäonnistui:", err);
  process.exit(1);
});

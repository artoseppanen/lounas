/**
 * reset-ratings.js
 *
 * Poistaa KAIKKI käyttäjien antamat oikeat arviot:
 *   1. Jokaisen restaurants/{id}/ratings/{userId} -dokumentin (collection group).
 *   2. Nollaa (poistaa kokonaan) realRatingSum/realRatingCount -kentät jokaiselta
 *      restaurants-dokumentilta.
 *
 * EI KOSKE: seedSum/seedCount (siemen) eikä mihinkään muuhun ravintolan
 * kenttään (nimi, sijainti, tyyppi, jne.) - nämä pysyvät täysin koskemattomina.
 *
 * Käyttö:
 *   node reset-ratings.js
 *
 * Vaatii serviceAccountKey.json samassa kansiossa (sama avain kuin
 * import-menu-sources.js:lle).
 */

const fs = require("fs");
const path = require("path");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

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

const BATCH_SIZE = 450;

async function deleteAllRatingDocs() {
  console.log("Haetaan kaikki arviodokumentit (collection group 'ratings')...");
  const snap = await db.collectionGroup("ratings").get();
  console.log(`Löytyi ${snap.size} arviota poistettavaksi.`);

  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    docs.slice(i, i + BATCH_SIZE).forEach((d) => batch.delete(d.ref));
    await batch.commit();
    console.log(`Poistettu ${Math.min(i + BATCH_SIZE, docs.length)}/${docs.length} arviota`);
  }
}

async function clearAggregateFields() {
  console.log("Nollataan realRatingSum/realRatingCount kaikilta ravintoloilta...");
  const snap = await db.collection("restaurants").get();
  const docs = snap.docs.filter(
    (d) => d.get("realRatingSum") !== undefined || d.get("realRatingCount") !== undefined
  );
  console.log(`${docs.length}/${snap.size} ravintolalla oli jotain nollattavaa.`);

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    docs.slice(i, i + BATCH_SIZE).forEach((d) => {
      batch.update(d.ref, {
        realRatingSum: FieldValue.delete(),
        realRatingCount: FieldValue.delete(),
      });
    });
    await batch.commit();
    console.log(`Nollattu ${Math.min(i + BATCH_SIZE, docs.length)}/${docs.length} ravintolaa`);
  }
}

async function main() {
  await deleteAllRatingDocs();
  await clearAggregateFields();
  console.log("\nValmis. seedSum/seedCount ja kaikki muu data pysyivät koskemattomina.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Nollaus epäonnistui:", err);
  process.exit(1);
});

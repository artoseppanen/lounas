/**
 * Lounas — Cloud Functions (2nd gen, Node.js 22)
 *
 * Alueet (kaupungit): Tampere ja Helsinki. Kullakin alueella on OMAT Firestore-kokoelmat
 * ja omat funktiot (ks. REGIONS alempana), joten yhden alueen data tai virhe ei voi
 * vaikuttaa toiseen. Tampere on alkuperäinen ja ennallaan; uudet alueet vain lisätään.
 *
 * Funktiot alueittain (Tampere / Helsinki):
 *  1. onRatingWrite       / onRatingWriteHelsinki
 *       päivittää ravintolan realRatingSum/realRatingCount AINA kun joku
 *       kirjoittaa/muuttaa/poistaa oman arvionsa. Asiakas ei koskaan itse laske
 *       eikä kirjoita aggregaattia.
 *  2. syncRestaurants     / syncRestaurantsHelsinki   (+ ...Manual)
 *       ajastettu (kerran vuorokaudessa): hakee Overpassista alueen ravintolat ja
 *       kirjoittaa/päivittää ne alueen restaurants-kokoelmaan. Vain NÄMÄ funktiot
 *       saavat koskea Overpassia - ei yksikään käyttäjän selain.
 *  3. syncDailyMenus      / syncDailyMenusHelsinki    (+ ...Manual)
 *       ajastettu: hakee alueen lounaslähteiden (menuSources) päivän listat,
 *       jäsentää ne alustakohtaisilla parsereilla ja siivoaa vanhat.
 *
 * Asenna riippuvuudet functions-kansiossa:
 *   npm install
 *
 * Deploy:
 *   firebase deploy --only functions
 */

const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Firestore ei salli "/"-merkkiä yhden dokumentin ID:ssä (se on aina polun
// erotinmerkki). OSM:n omat id:t ovat muotoa "node/12345" - tätä muotoa
// käytetään yhä SOVELLUKSEN SISÄLLÄ (kartta, popoverit) kaikkialla, mutta
// Firestore-dokumentin ID:nä käytetään aina tätä sanitoitua "node_12345"
// -muotoa. Alkuperäinen muoto säilytetään dokumentin "id"-kenttänä.
function sanitizeId(id) {
  return String(id).replace(/\//g, "_");
}

// ---------------------------------------------------------------------------
// Alueasetukset (kaupungit)
// ---------------------------------------------------------------------------
//
// Jokaisella alueella on OMAT Firestore-kokoelmansa, joten yhden alueen data tai
// virhe ei voi koskaan vaikuttaa toiseen. TAMPERE on alkuperäinen ja pysyy täsmälleen
// ennallaan (samat kokoelmat ja funktiot kuin ennen alueasetusta) - uudet alueet vain
// LISÄTÄÄN: omat kokoelmat, omat funktiot ja omat tietoturvasäännöt.
//
//  - bbox:         Overpass-haun rajaus "etelä,länsi,pohjoinen,itä"
//  - seedRatings:  true = uusille ravintoloille annetaan uskottava keksitty lähtöarvio
//                  (Tampere, ks. seedRatingFor). false = ei keksittyjä arvioita:
//                  seedSum/seedCount kirjoitetaan nollina, jolloin asiakas näyttää
//                  "Ei arvioita vielä" kunnes oikeita arvioita tulee.
const TAMPERE_BBOX = "61.435,23.640,61.560,23.900";
// Helsingin keskusta: ydinkeskusta + Ruoholahti (mitattu Overpassilla: 905 ravintolaa)
const HELSINKI_BBOX = "60.155,24.905,60.182,24.970";

const REGIONS = {
  tampere: {
    id: "tampere",
    bbox: TAMPERE_BBOX,
    restaurants: "restaurants",
    dailyMenus: "dailyMenus",
    menuSources: "menuSources",
    seedRatings: true,
  },
  helsinki: {
    id: "helsinki",
    bbox: HELSINKI_BBOX,
    restaurants: "restaurants_helsinki",
    dailyMenus: "dailyMenus_helsinki",
    menuSources: "menuSources_helsinki",
    seedRatings: false,
  },
};

// ---------------------------------------------------------------------------
// 1. Arvion aggregointi
// ---------------------------------------------------------------------------
//
// Triggeröityy jokaisesta restaurants/{restaurantId}/ratings/{userId} -muutoksesta
// (luonti, päivitys, poisto). Laskee ratingSum/ratingCount UUDELLEEN transaktiona
// vertaamalla ennen- ja jälkeen-tilaa — ei kumulatiivista +/- laskentaa, koska
// se ajautuisi helposti pieleen jos kaksi kirjoitusta osuu samaan hetkeen.
// Tehdas: sama aggregointilogiikka jokaiselle alueelle, kukin omaan kokoelmaansa.
function makeRatingHandler(region, name) {
  return async (event) => {
    const restaurantId = event.params.restaurantId;
    const beforeSnap = event.data.before;
    const afterSnap = event.data.after;

    const beforeRating = beforeSnap.exists ? beforeSnap.data().rating : null;
    const afterRating = afterSnap.exists ? afterSnap.data().rating : null;

    // Ei mitään muutosta arvoon (esim. muu kentän päivitys) -> ei tarvitse tehdä mitään.
    if (beforeRating === afterRating) return;

    const restaurantRef = db.collection(region.restaurants).doc(restaurantId);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(restaurantRef);
      if (!snap.exists) {
        logger.warn(`${name}: ravintolaa ${restaurantId} ei löytynyt, ohitetaan`);
        return;
      }
      const data = snap.data();
      // HUOM: nämä ovat ERILLISET kentät kuin seedSum/seedCount (ks. seedRatingFor
      // alempana) - tähän tallentuvat VAIN oikeat, käyttäjien antamat arviot.
      // Näin siemen voidaan poistaa myöhemmin koskematta oikeaan dataan lainkaan.
      let sum = data.realRatingSum || 0;
      let count = data.realRatingCount || 0;

      if (beforeRating != null) {
        // vanha arvio pois summasta
        sum -= beforeRating;
        count -= 1;
      }
      if (afterRating != null) {
        // uusi arvio summaan
        sum += afterRating;
        count += 1;
      }

      // Ei koskaan negatiiviseksi virhetilanteissa.
      count = Math.max(0, count);
      sum = count === 0 ? 0 : sum;

      tx.update(restaurantRef, { realRatingSum: sum, realRatingCount: count });
    });
  };
}

exports.onRatingWrite = onDocumentWritten(
  "restaurants/{restaurantId}/ratings/{userId}",
  makeRatingHandler(REGIONS.tampere, "onRatingWrite")
);
exports.onRatingWriteHelsinki = onDocumentWritten(
  "restaurants_helsinki/{restaurantId}/ratings/{userId}",
  makeRatingHandler(REGIONS.helsinki, "onRatingWriteHelsinki")
);

// ---------------------------------------------------------------------------
// 2. Ajastettu Overpass-synkronointi
// ---------------------------------------------------------------------------
//
// Ajetaan kerran vuorokaudessa (klo 04:00 Suomen aikaa). Hakee Tampereen
// ravintolat/kahvilat/pikaruokapaikat Overpassista ja kirjoittaa ne
// restaurants-kokoelmaan. Käyttää batch-kirjoitusta (max 500/erä).
// Uusi ravintola: luodaan ratingSum=0, ratingCount=0. Olemassa oleva:
// päivitetään vain OSM:stä tulevat kentät, EI kosketa ratingSum/ratingCount.
// (TAMPERE_BBOX ja HELSINKI_BBOX on määritelty alueasetuksessa ylhäällä.)
// Useampi julkinen Overpass-peili varalla. Pilvipalveluiden (Google Cloud,
// AWS, jne.) lähtevät IP-osoitteet ovat usein yhteisiä monelle asiakkaalle,
// joten yksi rajapinta voi hylätä pyynnön (429/5xx) vaikka itse et tekisi
// mitään väärin - silloin kokeillaan seuraavaa listalta.
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

async function fetchFromOverpass(query) {
  let lastError;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
          "User-Agent": "TampereenLounasBot/1.0 (+https://esimerkki.fi/bot-info)",
        },
        body: "data=" + encodeURIComponent(query),
      });
      if (res.ok) return await res.json();
      lastError = new Error(`Overpass HTTP ${res.status} (${url})`);
      logger.warn(`fetchFromOverpass: ${url} palautti ${res.status}, kokeillaan seuraavaa peiliä`);
    } catch (err) {
      lastError = err;
      logger.warn(`fetchFromOverpass: ${url} epäonnistui (${err.message}), kokeillaan seuraavaa peiliä`);
    }
  }
  throw lastError;
}

function buildOverpassQuery(bbox) {
  return `[out:json][timeout:60];
(
  node["amenity"~"^(restaurant|cafe|fast_food)$"](${bbox});
  way["amenity"~"^(restaurant|cafe|fast_food)$"](${bbox});
  relation["amenity"~"^(restaurant|cafe|fast_food)$"](${bbox});
);
out center tags;`;
}

function elementToRestaurant(el) {
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  const tags = el.tags || {};
  const street = tags["addr:street"];
  const num = tags["addr:housenumber"];
  const rawCuisine = tags.cuisine || "";
  return {
    id: `${el.type}/${el.id}`,
    lat,
    lon,
    name: tags.name || "Nimetön kohde",
    cuisineRaw: rawCuisine,
    cuisine: rawCuisine
      ? rawCuisine.replace(/_/g, " ").replace(/;/g, ", ")
      : "Tyyppi ei tiedossa",
    cuisineUnknown: !rawCuisine,
    amenity: tags.amenity || "",
    addr: street ? `${street}${num ? " " + num : ""}` : "",
    website: tags.website || tags["contact:website"] || "",
    openingHours: tags.opening_hours || "",
    // OSM:n ruokavaliotagit (arvot yes / only / limited / no) tallennetaan raakoina, tulkinta
    // tehdään asiakaspuolella (ks. index.html offersVege). Kentät kirjoitetaan
    // aina (tyhjänä jos tagia ei ole), jotta merge:true poistaa vanhan arvon jos tagi poistuu OSM:stä.
    dietVegetarian: tags["diet:vegetarian"] || "",
    dietVegan: tags["diet:vegan"] || "",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

exports.syncRestaurants = onSchedule(
  { schedule: "0 4 * * *", timeZone: "Europe/Helsinki", timeoutSeconds: 300 },
  async () => {
    await runSyncRestaurants(REGIONS.tampere);
  }
);
// Helsinki: oma funktio ja eri kellonaika (ei samaa aikaa Tampereen kanssa, jotta Overpass-pyynnöt
// eivät mene päällekkäin ja Helsingin virhe tai hitaus ei kaada Tampereen synkkaa).
exports.syncRestaurantsHelsinki = onSchedule(
  { schedule: "15 4 * * *", timeZone: "Europe/Helsinki", timeoutSeconds: 300 },
  async () => {
    await runSyncRestaurants(REGIONS.helsinki);
  }
);

// Sama deterministinen "uskottava lähtötilanne" -kaava jota aiemmin käytettiin
// pelkästään asiakaspuolella (localStorage-mockina). Nyt se kirjoitetaan
// KERRAN Firestoreen kun ravintola nähdään ensimmäistä kertaa, jonka jälkeen
// oikeat arviot (onRatingWrite) lisääntyvät suoraan tämän saman summan päälle
// - ei enää kahta erillistä järjestelmää, vain yksi ratingSum/ratingCount jota
// sekä siemen että oikeat arviot jakavat.
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function seedRatingFor(id) {
  const hash = hashStr(id);
  const count = 3 + (hash % 35);                  // 3–37 "muiden" arviota
  const avgSeed = 2.8 + ((hash >>> 5) % 21) / 10;   // 2.8–4.8 tähteä keskimäärin
  return { sum: Math.round(avgSeed * count), count };
}

async function runSyncRestaurants(region) {
  logger.info(`syncRestaurants[${region.id}]: haetaan Overpassista...`);

  const data = await fetchFromOverpass(buildOverpassQuery(region.bbox));

  const restaurants = data.elements
    .map(elementToRestaurant)
    .filter((r) => r.lat && r.lon);

  logger.info(`syncRestaurants[${region.id}]: ${restaurants.length} ravintolaa löytyi, kirjoitetaan...`);

  // Selvitetään mitkä ravintolat TARVITSEVAT vielä siemenen - eli joilta
  // puuttuu seedCount-kenttä kokonaan. Tämä (ei pelkkä "onko dokumentti
  // olemassa") on tarkoituksella kestävämpi tapa: se korjaa itsensä
  // automaattisesti vaikka ajaisit tämän monta kertaa peräkkäin, tai vaikka
  // edellinen kokoelman poisto olisi vielä kesken ajon alkaessa - ei väliä,
  // puuttuva kenttä täyttyy joka tapauksessa seuraavalla ajolla eikä oikeaan
  // realRatingSum/realRatingCount-dataan koskaan kosketa.
  const existingSnap = await db.collection(region.restaurants).select("seedCount").get();
  const idsWithSeed = new Set(
    existingSnap.docs.filter((d) => d.get("seedCount") !== undefined).map((d) => d.id)
  );

  // Firestoren batch-kirjoitus sallii max 500 operaatiota per erä.
  const BATCH_SIZE = 450;
  for (let i = 0; i < restaurants.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = restaurants.slice(i, i + BATCH_SIZE);
    for (const r of chunk) {
      const docId = sanitizeId(r.id);
      const payload = { ...r };
      if (!idsWithSeed.has(docId)) {
        // Siemen puuttuu -> annetaan se nyt, ei enää koskaan tämän jälkeen.
        // Alueilla ilman keksittyjä arvioita (seedRatings=false) kirjoitetaan nollat: kenttä on silti
        // olemassa, joten asiakas ja tämä logiikka toimivat täsmälleen samoin kuin Tampereella.
        const seed = region.seedRatings ? seedRatingFor(r.id) : { sum: 0, count: 0 };
        payload.seedSum = seed.sum;
        payload.seedCount = seed.count;
      }
      // merge:true -> jos siemen on jo olemassa, seedSum/seedCount EIVÄT ole
      // payloadissa lainkaan (ks. yllä), joten merge jättää ne koskemattomiksi.
      batch.set(db.collection(region.restaurants).doc(docId), payload, { merge: true });
    }
    await batch.commit();
    logger.info(`syncRestaurants[${region.id}]: kirjoitettu ${i + chunk.length}/${restaurants.length}`);
  }

  logger.info(`syncRestaurants[${region.id}]: valmis.`);
  return restaurants.length;
}

// Manuaalinen laukaisin PoC/kehitysvaihetta varten - sama SYNC_SECRET-suojaus
// kuin syncDailyMenusManual. Kutsu esim:
// https://<alue>-<projekti>.cloudfunctions.net/syncRestaurantsManual?secret=...
// Yhteinen käsittelijä kaikille manuaalilaukaisimille (SYNC_SECRET-suojaus, virheilmoitukset).
// run() palauttaa vastaukseen yhdistettävät kentät (ok: true lisätään automaattisesti).
async function handleManualSync(req, res, name, run) {
  const expected = (process.env.SYNC_SECRET || "").trim();
  if (!expected) {
    res.status(500).send("SYNC_SECRET-ympäristömuuttujaa ei ole asetettu palvelimella.");
    return;
  }
  const given = (req.query.secret || "").toString();
  if (given !== expected) {
    // Ei koskaan paljasteta itse arvoja, vain pituudet - auttaa löytämään
    // näkymättömät välilyönnit/rivinvaihdot jotka aiheuttavat epäsuoran eron.
    res.status(403).send(
      `Väärä tai puuttuva secret-parametri. (annetun pituus: ${given.length}, ` +
      `palvelimen arvon pituus: ${expected.length})`
    );
    return;
  }
  try {
    const payload = await run();
    res.status(200).json({ ok: true, ...payload });
  } catch (err) {
    logger.error(`${name} epäonnistui:`, err);
    res.status(500).json({ ok: false, error: String(err) });
  }
}

// Manuaalinen laukaisin PoC/kehitysvaihetta varten - sama SYNC_SECRET-suojaus
// kuin syncDailyMenusManual. Kutsu esim:
// https://<alue>-<projekti>.cloudfunctions.net/syncRestaurantsManual?secret=...
exports.syncRestaurantsManual = onRequest({ timeoutSeconds: 300 }, (req, res) =>
  handleManualSync(req, res, "syncRestaurantsManual", async () => ({ count: await runSyncRestaurants(REGIONS.tampere) }))
);
exports.syncRestaurantsHelsinkiManual = onRequest({ timeoutSeconds: 300 }, (req, res) =>
  handleManualSync(req, res, "syncRestaurantsHelsinkiManual", async () => ({ count: await runSyncRestaurants(REGIONS.helsinki) }))
);

// ---------------------------------------------------------------------------
// 3. Lounaslistojen haku ja jäsennys — Poweresta-alusta
// ---------------------------------------------------------------------------
//
// Poweresta on useamman ravintolaketjun käyttämä lounaslista-järjestelmä
// (havaittu mm. Ninan Keittiön ~10 ravintolassa). YKSI parseri kattaa kaikki
// samaa alustaa käyttävät ravintolat — ei tarvitse kirjoittaa parseria
// jokaiselle ravintolalle erikseen, vain jokaiselle ALUSTALLE.
//
// HUOM tärkeä oletus, joka kannattaa varmistaa ensimmäisen oikean ajon jälkeen:
// oletan sivun käyttävän tavallisia otsikkotasoja (h2-h5) päivä- ja
// osiorakenteeseen, koska se on WordPress-sivuilla ylivoimaisesti yleisin
// tapa. Jos parseri löytää 0 päivää, tarkista view-source ja säädä
// DAY_HEADING_SELECTOR / SECTION_HEADING_SELECTOR alla.
//
// Vaatii riippuvuuden: npm install cheerio
const cheerio = require("cheerio");
const pdfParse = require("pdf-parse");

// Yksi hidas tai jumissa oleva sivu ei saa syödä koko ajon aikabudjettia kun
// käsitellään satoja lähteitä - jokaiselle yksittäiselle haulle oma raja.
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const FI_WEEKDAYS = ["Maanantai", "Tiistai", "Keskiviikko", "Torstai", "Perjantai"];
const SECTION_NAMES = ["Pääruoaksi", "Pääruoan kaveriksi", "Keitto", "Jälkiruoka"];

// [koodi, suomenkielinen selite] — merkitään ruokanimen perään ilman väliä,
// esim. "...kastikettaLLaktoositon" -> koodi "L", selite poistetaan tekstistä.
const ALLERGEN_PAIRS = [
  ["VL", "Vähälaktoosinen"],
  ["KM", "Kananmunaton"],
  ["Veg", "Vegaaninen"],
  ["L", "Laktoositon"],
  ["G", "Gluteeniton"],
  ["M", "Maidoton"],
];

function extractAllergens(rawText) {
  let text = rawText.trim();
  const found = [];
  for (const [code, label] of ALLERGEN_PAIRS) {
    const marker = code + label;
    while (text.includes(marker)) {
      text = text.replace(marker, "");
      found.push(code);
    }
  }
  return { name: text.trim(), allergens: [...new Set(found)] };
}

// Poweresta-alustan päivittäinen PDF on ennustettavassa osoitteessa, esim.
// https://www.ninankeittio.fi/wp-content/uploads/poweresta/tammela-ruokalistat-2026-09-28-fi.pdf
// Tämä EI ole Cloudflaren JS-haasteen takana (toisin kuin itse HTML-sivu),
// joten se on nyt ainoa tapa jolla Poweresta-ravintoloiden data haetaan.
// menuSources-dokumentin täytyy sisältää kenttä "pdfUrlPattern", jossa
// päivämäärän paikalla on kirjaimellisesti "{date}", esim.
// "https://www.ninankeittio.fi/wp-content/uploads/poweresta/tammela-ruokalistat-{date}-fi.pdf"
const POWERESTA_CATEGORY_MAP = {
  "PÄÄRUOAKSI": "Pääruoaksi",
  "PÄÄRUOAN KAVERIKSI": "Pääruoan kaveriksi",
  "KEITTO": "Keitto",
  "JÄLKIRUOKA": "Jälkiruoka",
};
const POWERESTA_ALLERGEN_CODES = new Set(["L", "M", "G", "Veg", "KM", "VL"]);

function extractAllergensFromWords(line) {
  const words = line.trim().split(/\s+/);
  const allergens = [];
  while (words.length > 1 && POWERESTA_ALLERGEN_CODES.has(words[words.length - 1])) {
    allergens.unshift(words.pop());
  }
  return { name: words.join(" "), allergens };
}

// PDF-tekstin rivijärjestys EI vastaa visuaalista lukujärjestystä (yleinen
// PDF-erikoisuus) - siksi hinnat poimitaan omana kokoteksti-hakuna, ja
// ruokalajit tunnistetaan aina "nykyinen osio" -tilakoneella, joka nollataan
// heti kun tulee vastaan tunnistamaton "kohinarivi" (ravintolan nimi,
// päivämääräotsikko, allergeeniselite, juridinen teksti jne.) - näin
// mikään irrallinen rivi ei voi vahingossa liimautua väärään osioon.
function isPowerestaNoiseLine(line) {
  if (/^www\./i.test(line)) return true;
  if (/^(L|M|G|Veg|KM|VL)\s+[A-ZÄÖÅa-zäöå]+$/.test(line)) return true; // allergeeniselite
  if (/^Käytämme suomalaista lihaa/i.test(line)) return true;
  if (/^Ilmoitamme kirjallisesti/i.test(line)) return true;
  if (/^Oikeudet$/i.test(line)) return true;
  if (/^muutoksiin pidätetään/i.test(line)) return true;
  if (/^Hinnat sisältävät/i.test(line)) return true;
  if (/^Katso viikon$/i.test(line)) return true;
  if (/^lounaslista$/i.test(line)) return true;
  if (/^ja sijaintimme$/i.test(line)) return true;
  if (/^(Lounasbuffet|Keittolounas)\s/i.test(line)) return true; // hinta, käsitelty erikseen
  // Kokonaan isoilla kirjoitettu monisanainen rivi joka ei ole osio-otsikko
  // -> ravintolan nimi tai "MAANANTAI 28.9.2026" -tyylinen päivämääräotsikko.
  if (line === line.toUpperCase() && /[A-ZÄÖÅ]/.test(line) && !POWERESTA_CATEGORY_MAP[line]) return true;
  return false;
}

function parsePowerestaPdfText(pdfText, dateIso) {
  const lines = pdfText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const prices = [];
  const priceRegex = /(Lounasbuffet|Keittolounas)\s+([\d,.]+)\s*euroa/gi;
  let m;
  while ((m = priceRegex.exec(pdfText)) !== null) {
    prices.push({ label: m[1], price: m[2] + " €" });
  }

  const sections = {};
  let currentSection = null;
  for (const line of lines) {
    const mappedCategory = POWERESTA_CATEGORY_MAP[line];
    if (mappedCategory) {
      currentSection = mappedCategory;
      sections[currentSection] = sections[currentSection] || [];
      continue;
    }
    if (isPowerestaNoiseLine(line)) {
      currentSection = null;
      continue;
    }
    if (currentSection) {
      const { name, allergens } = extractAllergensFromWords(line);
      if (name) sections[currentSection].push({ name, allergens });
    }
  }

  if (Object.keys(sections).length === 0) return null;
  return { dateIso, prices, sections };
}

/**
 * Hakee ja jäsentää yhden Poweresta-ravintolan PÄIVÄN PDF:n (ei koko viikon
 * HTML-sivua, ks. yllä oleva selitys), kirjoittaa tuloksen
 * dailyMenus/{restaurantId}_{päivämäärä} -dokumenttiin.
 */
async function syncOnePowerestaMenu(restaurantId, sourceData, region = REGIONS.tampere) {
  const dateIso = new Date().toISOString().slice(0, 10);
  const ref = db.collection(region.dailyMenus).doc(`${restaurantId}_${dateIso}`);

  const pdfUrlPattern = sourceData.pdfUrlPattern;
  if (!pdfUrlPattern) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: 'menuSources-dokumentista puuttuu "pdfUrlPattern"-kenttä.',
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOnePowerestaMenu: ${restaurantId} - pdfUrlPattern puuttuu`);
    return;
  }

  const pdfUrl = pdfUrlPattern.replace("{date}", dateIso);
  const res = await fetchWithTimeout(pdfUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} haettaessa PDF:ää ${pdfUrl}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const pdfData = await pdfParse(buffer);

  const parsed = parsePowerestaPdfText(pdfData.text, dateIso);
  if (!parsed) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: pdfData.text.slice(0, 2000),
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOnePowerestaMenu: ${restaurantId} - PDF:stä ei löytynyt osioita`);
    return;
  }

  await ref.set({
    restaurantId,
    date: dateIso,
    parseStatus: "ok",
    prices: parsed.prices,
    sections: parsed.sections,
    checkedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logger.info(`syncOnePowerestaMenu: ${restaurantId} - tallennettu PDF:stä onnistuneesti`);
}

// ---------------------------------------------------------------------------
// 4. Lounaslistojen haku ja jäsennys — Linkosuon oma järjestelmä
// ---------------------------------------------------------------------------
//
// Linkosuolla (linkosuo.fi/toimipaikka/*) on ~13 toimipaikkaa, kaikki samalla
// alustalla. HUOM tämä rakenne on Poweresta-alustaa huomattavasti sotkuisempi:
// ei omia otsikkotasoja ruokalajeille, kaksi ruokalajia usein samalla rivillä
// "&"-merkillä yhdistettynä, eikä päivämäärässä ole vuosilukua. Tämän takia
// EN yritä jaotella ruokia Pääruoka/Lisäke/Keitto/Jälkiruoka-kategorioihin
// kuten Powerestalla — tallennan päivän ruoat yhtenä listana ("items"), koska
// väärä kategorisointi olisi pahempi kuin ei kategorisointia lainkaan.
const FI_WEEKDAY_RE = /^(Maanantai|Tiistai|Keskiviikko|Torstai|Perjantai)\s+(\d{1,2})\.(\d{1,2})\.?\s*$/;

function currentYearFor(month) {
  // Sivulla ei ole vuosilukua. Oletetaan kuluva vuosi, paitsi jos kyseessä
  // on looginen "vuodenvaihde" (esim. tammikuun viikko joulukuun lopulla
  // haettuna) - riittävän harvinaista ettei sitä käsitellä erikseen tässä.
  return new Date().getFullYear();
}

// HUOM: kokeilin ensin rivikohtaista jäsennystä (pilkkoa "&"-merkistä,
// irrota allergeenit per pala) mutta se hajosi oikealla datalla kahdesta
// syystä: (1) sivulla ei ole mitään luotettavaa rajaa suomen ja englannin
// välissä (Poweresta toistaa päivämäärän englanniksi omana otsikkonaan,
// Linkosuo ei), joten englanti vuotaa suomenkielisen listan sekaan; (2)
// moniosaiset ruokanimet jotka itsessään sisältävät "&"-merkin pilkkoutuvat
// väärin ja allergeenit irtoavat väärästä kohdasta. Väärä mutta siisti data
// on pahempi kuin raaka mutta oikea, joten tallennetaan koko päivän
// tekstilohko sellaisenaan sen sijaan että väitettäisiin ymmärtävämme
// rakennetta jota emme oikeasti luotettavasti ymmärrä.
function parseLinkosuoHtml(html) {
  const $ = cheerio.load(html);
  const days = {};

  // Sivun oikea rakenne (vahvistettu oikeasta lähdekoodista): päivät ovat
  // <dt>Maanantai 28.09.</dt><dd>...koko päivän sisältö...</dd> -pareja, EI
  // erillisiä <p>-elementtejä. Yhden <dd>:n sisällä rivit on eroteltu
  // <br>-tageilla, ei omina elementteinään, joten ne pitää purkaa erikseen.
  $("dt").each((_, dtEl) => {
    const dtText = $(dtEl).text().trim();
    const dayMatch = dtText.match(FI_WEEKDAY_RE);
    if (!dayMatch) return; // esim. muu <dt> joka ei ole viikonpäivä

    const [, , day, month] = dayMatch;
    const year = currentYearFor(month);
    const pad = (n) => String(n).padStart(2, "0");
    const dateIso = `${year}-${pad(month)}-${pad(day)}`;

    const ddEl = $(dtEl).next("dd");
    if (!ddEl.length) return;

    // <br> ei tuota rivinvaihtoa cheerion .text()-kutsussa - korvataan se
    // ensin näkyvällä merkillä ennen tekstin poimintaa.
    const innerHtml = (ddEl.html() || "").replace(/<br\s*\/?>/gi, "\n");
    const lineText = cheerio.load(`<div>${innerHtml}</div>`)("div").first().text();
    const lines = lineText.split("\n").map((l) => l.trim()).filter(Boolean);

    const prices = [];
    const rawLines = [];
    lines.forEach((line) => {
      if (/€/.test(line) && /,/.test(line) && prices.length === 0 && rawLines.length === 0) {
        const priceMatches = [...line.matchAll(/([A-Za-zÄÖÅäöå''\- ]+?)\s+([\d,.]+)\s*€/g)];
        if (priceMatches.length > 0) {
          priceMatches.forEach((m) => prices.push({ label: m[1].trim(), price: m[2] + " €" }));
          return;
        }
      }
      rawLines.push(line);
    });

    days[dateIso] = { dateIso, prices, rawText: rawLines.join("\n") };
  });

  return days;
}

async function syncOneLinkosuoMenu(restaurantId, sourceData, region = REGIONS.tampere) {
  const url = sourceData.url;
  const res = await fetchWithTimeout(url, {
    headers: {
      // Realistinen selain-User-Agent + tavalliset selainotsikot. Sivu on
      // Cloudflaren takana, joka näyttää tunnistavan tunnistautuvan
      // bot-User-Agentin ja palauttaa sille eri (sisällöttömän) sivun kuin
      // oikealle selaimelle - tämä on yritys ohittaa se.
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "fi-FI,fi;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} haettaessa ${url}`);
  const html = await res.text();

  let days;
  try {
    days = parseLinkosuoHtml(html);
  } catch (err) {
    logger.error(`Linkosuo-jäsennys epäonnistui (${restaurantId}):`, err);
    days = {};
  }

  const dateKeys = Object.keys(days);
  if (dateKeys.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    await db.collection(region.dailyMenus).doc(`${restaurantId}_${today}`).set({
      restaurantId,
      date: today,
      parseStatus: "failed",
      rawTextSnippet: cheerio.load(html)("body").text().slice(0, 2000),
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneLinkosuoMenu: ${restaurantId} - ei löytynyt päiviä, tallennettu raaka fallback`);
    return;
  }

  const batch = db.batch();
  for (const dateIso of dateKeys) {
    const day = days[dateIso];
    const ref = db.collection(region.dailyMenus).doc(`${restaurantId}_${dateIso}`);
    batch.set(ref, {
      restaurantId,
      date: dateIso,
      // "partial", ei "ok", koska ruokia ei jaotella kategorioihin kuten
      // Powerestalla - UI:n kannattaa näyttää tämä hieman eri tavalla.
      parseStatus: "partial",
      prices: day.prices,
      rawText: day.rawText,
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  logger.info(`syncOneLinkosuoMenu: ${restaurantId} - tallennettu ${dateKeys.length} päivää`);
}

// ---------------------------------------------------------------------------
// 5. Geneerinen fallback yksittäisille, ei-ketjuun-kuuluville ravintoloille
// ---------------------------------------------------------------------------
//
// Ei osaa mitään sivukohtaista rakennetta - hakee sivun, poistaa parhaansa
// mukaan navigaation/footerin/evästebannerit yleisillä tunnisteilla, ja
// tallentaa jäljelle jäävän tekstin sellaisenaan raakana (sama "partial"-
// filosofia kuin Linkosuolla: raaka mutta oikea on parempi kuin siisti mutta
// väärä). EI yritä poimia hintoja rakenteisena, koska sivukohtaista hintojen
// sijaintia ei tunneta - kaikki menee yhtenä tekstilohkona.
async function syncOneGenericMenu(restaurantId, sourceData, region = REGIONS.tampere) {
  const url = sourceData.url;
  const dateIso = new Date().toISOString().slice(0, 10);
  const ref = db.collection(region.dailyMenus).doc(`${restaurantId}_${dateIso}`);

  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} haettaessa ${url}`);
  const html = await res.text();

  const $ = cheerio.load(html);
  // Poistetaan yleisimmät ei-sisältö-elementit ennen tekstin poimintaa.
  $("script, style, nav, header, footer, form, noscript, svg, iframe, aside").remove();
  $(
    '[class*="cookie" i], [id*="cookie" i], [class*="nav" i], [class*="menu-toggle" i], ' +
    '[class*="sidebar" i], [class*="banner" i], [class*="popup" i], [class*="modal" i], ' +
    '[class*="breadcrumb" i], [class*="search" i], [class*="social" i], [class*="newsletter" i], ' +
    '[role="navigation"], [role="banner"], [role="contentinfo"], [role="search"], [role="dialog"]'
  ).remove();

  // WordPress-sivuilla (erittäin yleinen alusta pienille ravintolasivuille)
  // itse sisältö on lähes aina ".entry-content"-luokassa - tämä osuu paljon
  // luotettavammin oikeaan kohtaan kuin main/article-arvaus, koska main/
  // article saattavat sisältää myös sivupalkkeja tai muuta ympäröivää
  // rakennetta joka laimentaa/rikkoo poiminnan.
  const entryContent = $(".entry-content").first();
  const main = $("main").first();
  const article = $("article").first();
  const container = entryContent.length ? entryContent : (main.length ? main : (article.length ? article : $("body")));

  // <br> puretaan ensin näkyväksi rivinvaihdoksi, samaan tapaan kuin muillakin
  // parsereilla - muuten sen sisältämä rivinvaihto katoaisi tekstin poiminnassa.
  container.find("br").replaceWith("\n");

  // Monet sivukoneet (esim. Zyro/Hostinger, Wix, Webflow) tuottavat HTML:n
  // ilman MITÄÄN välilyöntejä tai rivinvaihtoja elementtien välissä
  // lähdekoodissa - container.text().split("\n") ei silloin löydä yhtään
  // rivinvaihtoa ja koko sisältö tulisi yhtenä pötkönä. Sen sijaan poimitaan
  // jokainen tekstielementti (otsikot, kappaleet, listat) ERIKSEEN omaksi
  // rivikseen riippumatta lähdekoodin muotoilusta.
  const blockSelector = "h1, h2, h3, h4, h5, h6, p, li, dt, dd, blockquote";
  const blockEls = container.find(blockSelector);

  let lines;
  if (blockEls.length >= 3) {
    lines = [];
    blockEls.toArray().forEach((el) => {
      // .clone().find(...).remove() poistaa sisäkkäiset otsikko/kappale-
      // elementit kloonista ennen tekstin lukemista, jottei sama sisältö
      // tule mukaan sekä ulomman että sisemmän elementin kohdalla kahdesti.
      const ownText = $(el).clone().find(blockSelector).remove().end().text();
      ownText.split("\n").forEach((part) => {
        const t = part.replace(/[ \t]+/g, " ").trim();
        if (t.length > 2) lines.push(t);
      });
    });
  } else {
    // Harvinainen fallback: ei juuri rakenteisia elementtejä - luotetaan
    // lähdekoodin omiin rivinvaihtoihin kuten ennenkin.
    lines = container.text().split("\n").map((l) => l.trim()).filter((l) => l.length > 2);
  }

  // Poistetaan peräkkäiset TÄSMÄLLEEN samat rivit - yleinen syy "ylimääräiselle"
  // sisällölle on että sama valikko/otsikko toistuu mobiili- ja työpöytäversiona
  // vierekkäin DOM:ssa vaikka vain toinen näkyy kerrallaan selaimessa.
  const deduped = lines.filter((l, i) => l !== lines[i - 1]);

  const text = deduped
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, 4000); // järkevä yläraja Firestore-dokumentin koolle

  if (!text || text.length < 20) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: "Sivulta ei löytynyt tulkittavaa sisältöä geneerisellä poiminnalla.",
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneGenericMenu: ${restaurantId} - ei löytynyt tulkittavaa sisältöä`);
    return;
  }

  await ref.set({
    restaurantId,
    date: dateIso,
    parseStatus: "partial",
    prices: [],
    rawText: text,
    checkedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logger.info(`syncOneGenericMenu: ${restaurantId} - tallennettu geneerisenä raakatekstinä`);
}

// ---------------------------------------------------------------------------
// 6. "4 Vuodenaikaa" (ja mahdolliset muut samalla WordPress/Gutenberg-
//    rakenteella tehdyt sivut: h3.menu-title + section > p.wp-block-paragraph,
//    rivit <br>-eroteltuina, hinta viimeisenä rivinä samassa kappaleessa)
// ---------------------------------------------------------------------------
// Ei yritetä pakottaa ruokia mihinkään kiinteään Pääruoka/Lisäke/Keitto/
// Jälkiruoka-kategoriointiin, koska tämän sivun rakenne (ranskalainen menu,
// hinnat per annos, ei yhtä kokonaishintaa) ei vastaa sitä mallia lainkaan.
// Tallennetaan siistitty mutta muuten sellaisenaan oleva teksti, parseStatus
// "partial" - sama toimiva periaate kuin Linkosuolla.
async function syncOneQuatreSaisonsMenu(restaurantId, sourceData, region = REGIONS.tampere) {
  const url = sourceData.url;
  const dateIso = new Date().toISOString().slice(0, 10);
  const ref = db.collection(region.dailyMenus).doc(`${restaurantId}_${dateIso}`);

  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} haettaessa ${url}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const container = $(".menu-content").first();
  if (!container.length) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: '".menu-content"-elementtiä ei löytynyt sivulta - rakenne on ehkä muuttunut.',
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneQuatreSaisonsMenu: ${restaurantId} - .menu-content puuttuu`);
    return;
  }

  const lines = [];
  container.find("h3.menu-title, h4, p").each((_, el) => {
    // <br> ei tuota rivinvaihtoa .text()-kutsussa - puretaan se ensin näkyväksi.
    const innerHtml = ($(el).html() || "").replace(/<br\s*\/?>/gi, "\n");
    const text = cheerio.load(`<div>${innerHtml}</div>`)("div").first().text().trim();
    if (text) lines.push(text);
  });

  const rawText = lines.join("\n\n");
  if (rawText.length < 10) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: "Sivulta löytyi .menu-content, mutta sen sisältö oli tyhjä.",
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneQuatreSaisonsMenu: ${restaurantId} - tyhjä sisältö`);
    return;
  }

  await ref.set({
    restaurantId,
    date: dateIso,
    parseStatus: "partial",
    prices: [],
    rawText,
    checkedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logger.info(`syncOneQuatreSaisonsMenu: ${restaurantId} - tallennettu onnistuneesti`);
}

// ---------------------------------------------------------------------------
// 7. Raflaamo (S-ryhmän ravintoloiden yhteinen alusta - ABC, Rosso, Amarillo,
//    Fransmanni, jne. Kattaa potentiaalisesti kymmeniä ravintoloita listalla.)
// ---------------------------------------------------------------------------
// Sivu näyttää havaintojen perusteella vain kuluvan päivän JA tulevat päivät
// (menneet arkipäivät eivät näy), joten ENSIMMÄINEN data-testid="menu" -lohko
// on aina tämän päivän menu - ei tarvitse hauraita päivämäärävertailuja.
// Jokainen otsikko/nimi toistuu HTML:ssä kahdesti (reagoivan typografian
// duplikaattikomponentit), joten käytetään aina .first()-valintaa.
async function syncOneRaflaamoMenu(restaurantId, sourceData, region = REGIONS.tampere) {
  const url = sourceData.url;
  const dateIso = new Date().toISOString().slice(0, 10);
  const ref = db.collection(region.dailyMenus).doc(`${restaurantId}_${dateIso}`);

  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} haettaessa ${url}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const todayMenu = $('div[data-testid="menu"]').first();
  if (!todayMenu.length) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: 'Sivulta ei löytynyt yhtään data-testid="menu" -lohkoa - rakenne on ehkä muuttunut.',
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneRaflaamoMenu: ${restaurantId} - ei menu-lohkoja`);
    return;
  }

  const headerText = todayMenu.find("h3").first().text().replace(/\s+/g, " ").trim();
  logger.info(`syncOneRaflaamoMenu: ${restaurantId} - käsitellään lohko "${headerText}"`);

  const prices = [];
  const rawLines = [];

  todayMenu.find("li").each((_, li) => {
    const $li = $(li);
    const name = $li.find('[data-testid="portion-name"]').first().text().trim();
    const priceRaw = $li.find('[data-testid="product-price-normal"]').first().text().trim();
    const price = priceRaw.replace(/^Hinta:\s*/i, "").trim();
    if (name && price) prices.push({ label: name, price });

    const descText = $li.find("p").first().text().trim();

    // Allergeeni/ruokavaliomerkinnät (esim. "G" = Gluteeniton) ovat
    // span[title]-elementteinä nimen vieressä silloin kun rivillä ei ole
    // hintaa eikä kuvausta - esim. yksittäiset ruokalajit jotka kuuluvat
    // isomman "päivän lounas" -kokonaisuuden sisään.
    const dietCodes = [];
    $li.find("span[title]").each((_, s) => {
      const code = $(s).text().trim();
      if (code) dietCodes.push(code);
    });
    const dietSuffix = dietCodes.length ? ` ${dietCodes.join(" ")}` : "";

    // Ei koskaan pudoteta nimettyä riviä, vaikka siltä puuttuisi sekä hinta
    // että kuvausteksti (esim. "Oksan päivän lounas" -kokonaisuuteen kuuluvat
    // yksittäiset ruokalajit, joilla ei ole omaa hintaa eikä kuvausta).
    if (name && descText) {
      rawLines.push(`${name}:\n${descText}`);
    } else if (name) {
      rawLines.push(`${name}${dietSuffix}`);
    } else if (descText) {
      rawLines.push(descText);
    }
  });

  const rawText = rawLines.join("\n\n");
  if (!rawText && prices.length === 0) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: `Lohko "${headerText}" löytyi, mutta siitä ei saatu poimittua hintoja eikä sisältöä.`,
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneRaflaamoMenu: ${restaurantId} - tyhjä sisältö`);
    return;
  }

  await ref.set({
    restaurantId,
    date: dateIso,
    parseStatus: "partial",
    prices,
    rawText,
    checkedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logger.info(`syncOneRaflaamoMenu: ${restaurantId} - tallennettu onnistuneesti`);
}

// ---------------------------------------------------------------------------
// 8. Compass Group / Foodco (Amica ym. - kattaa satoja ravintoloita eri
//    puolilla Suomea, compass-group.fi-domainilla)
// ---------------------------------------------------------------------------
// Sivun näkyvä HTML on Vue-sovellus jonka sisältö renderöityy vasta
// JavaScriptillä - suora fetch() ei näe sitä. Sivulla on kuitenkin palvelimen
// jo valmiiksi kirjoittama <script>window.__INITIAL_MENU__ = {...}</script>
// jonka sisältö ON palvelinpuolella renderöity ja jo täsmälleen tämän päivän
// dataa (dayMenu). Tämä on jopa parempi kuin sivun hakukone-JSON-LD, koska
// "bundlet" (useampi ruokalaji yhdessä, esim. "Lihapullia, kastiketta ja
// puolukkaa") ovat siinä JO valmiiksi yhdistetty luonnolliseksi lauseeksi -
// ei tarvitse arvata mitkä ruoat kuuluvat yhteen.
async function syncOneCompassGroupMenu(restaurantId, sourceData, region = REGIONS.tampere) {
  const url = sourceData.url;
  const dateIso = new Date().toISOString().slice(0, 10);
  const ref = db.collection(region.dailyMenus).doc(`${restaurantId}_${dateIso}`);

  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} haettaessa ${url}`);
  const html = await res.text();

  const scriptMatch = html.match(/window\.__INITIAL_MENU__\s*=\s*(\{[\s\S]*?\});?\s*(?:<\/script>|$)/);
  if (!scriptMatch) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: 'Sivulta ei löytynyt "window.__INITIAL_MENU__" -dataa - rakenne on ehkä muuttunut.',
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneCompassGroupMenu: ${restaurantId} - __INITIAL_MENU__ puuttuu`);
    return;
  }

  let data;
  try {
    data = JSON.parse(scriptMatch[1]);
  } catch (err) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: `__INITIAL_MENU__ löytyi mutta sen jäsennys epäonnistui: ${err.message}`,
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneCompassGroupMenu: ${restaurantId} - JSON.parse epäonnistui`);
    return;
  }

  const datePart = (iso) => String(iso || "").slice(0, 10);

  // dayMenu on palvelimen jo valmiiksi valitsema "tämän päivän" data koska
  // sivu haettiin ilman erillistä päivämääräparametria - varmistetaan silti
  // että se oikeasti täsmää, ja jos ei, etsitään oikea päivä weekMenu:sta.
  let menu = data.dayMenu;
  if (!menu || datePart(menu.date) !== dateIso) {
    const weekMenus = (data.weekMenu && data.weekMenu.menus) || [];
    menu = weekMenus.find((m) => datePart(m.date) === dateIso) || null;
  }

  if (!menu) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: `__INITIAL_MENU__ löytyi, mutta tämän päivän (${dateIso}) dataa ei löytynyt siitä.`,
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneCompassGroupMenu: ${restaurantId} - tämän päivän dataa ei löytynyt`);
    return;
  }

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const prices = [];
  const rawLines = [];

  for (const pkg of menu.menuPackages || []) {
    const headerText = clean(pkg.name);
    if (!headerText) continue; // tyhjät "täyte"-paketit (esim. sortOrder 52) ohitetaan

    // Poimitaan hinta otsikon lopusta jos sellainen on (esim. "...13,50€"),
    // muuten koko otsikko jää sellaisenaan (esim. "...sisältyy lounaaseen").
    const priceMatch = headerText.match(/(\d+[,.]\d+)\s*€\s*$/);
    const label = priceMatch ? clean(headerText.slice(0, priceMatch.index)) : headerText;
    if (priceMatch) prices.push({ label, price: priceMatch[1] + " €" });

    const lines = [];
    // Bundlet ensin - niiden "name"-kenttä on jo valmiiksi yhdistetty
    // luonnollinen lause, ei tarvitse koskea.
    for (const b of pkg.bundles || []) {
      const bundleText = clean(b.name);
      if (bundleText) lines.push(bundleText);
    }
    // Sitten ne yksittäiset ruoat joita EI ole jo katettu jonkin bundlen
    // kautta (meal.bundleId puuttuu = ei kuulu mihinkään bundleen).
    for (const meal of pkg.meals || []) {
      if (meal.bundleId) continue;
      const name = clean(meal.name);
      if (!name) continue;
      const diets = (meal.diets || []).filter(Boolean).join(", ");
      lines.push(diets ? `${name} (${diets})` : name);
    }

    if (lines.length) rawLines.push([label, ...lines].join("\n"));
  }

  const rawText = rawLines.join("\n\n");
  if (!rawText) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: "Tämän päivän data löytyi, mutta siitä ei saatu poimittua yhtään sisältöä.",
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneCompassGroupMenu: ${restaurantId} - tyhjä sisältö`);
    return;
  }

  await ref.set({
    restaurantId,
    date: dateIso,
    parseStatus: "partial",
    prices,
    rawText,
    checkedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logger.info(`syncOneCompassGroupMenu: ${restaurantId} - tallennettu onnistuneesti (__INITIAL_MENU__)`);
}

// ---------------------------------------------------------------------------
// 9. Elementor "nested tabs" -viikkolista (WordPress + Elementor-lisäosa,
//    yleinen rakenne pienillä ravintolasivuilla: yksi välilehti per viikonpäivä)
// ---------------------------------------------------------------------------
// Koko sivu (hero-teksti, yhteystiedot, JA lounaslista) elää saman
// ".entry-content"-elementin sisällä Elementorilla, joten se ei riitä
// erottamaan olennaista - sen sijaan etsitään Elementorin OMAT tabs-luokat
// (e-n-tabs, e-n-tab-title, jne.), jotka ovat samat kaikilla Elementor-
// sivuilla riippumatta sivun sisällöstä. Tunnistetaan tämän päivän välilehti
// suomenkielisen viikonpäivän nimen perusteella, luetaan siitä ruokalista
// (ensimmäinen otsikko+tekstieditori-pari) ja hinnat ("Hinta"-otsikon alta),
// ohitetaan "Allergiamerkinnät"-osio koska se on sama joka päivä (ei
// päiväkohtaista tietoa).
async function syncOneElementorTabsMenu(restaurantId, sourceData, region = REGIONS.tampere) {
  const url = sourceData.url;
  const dateIso = new Date().toISOString().slice(0, 10);
  const ref = db.collection(region.dailyMenus).doc(`${restaurantId}_${dateIso}`);

  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} haettaessa ${url}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const FI_WEEKDAYS = ["sunnuntai", "maanantai", "tiistai", "keskiviikko", "torstai", "perjantai", "lauantai"];
  const todayWeekday = FI_WEEKDAYS[new Date().getDay()];

  let targetPanelId = null;
  $(".e-n-tab-title").each((_, btn) => {
    if (targetPanelId) return;
    const text = $(btn).text().trim().toLowerCase();
    if (text.startsWith(todayWeekday)) {
      targetPanelId = $(btn).attr("aria-controls");
    }
  });
  // Fallback: sivun oletuksena aktiiviseksi merkitty välilehti, jos
  // viikonpäivän nimeä ei jostain syystä löytynyt (esim. kirjoitusasu eroaa).
  if (!targetPanelId) {
    targetPanelId = $('.e-n-tab-title[aria-selected="true"]').first().attr("aria-controls") || null;
  }

  const panel = targetPanelId ? $(`#${targetPanelId}`) : $();
  if (!panel.length) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: `Tämän päivän (${todayWeekday}) välilehteä ei löytynyt Elementorin tabs-rakenteesta.`,
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneElementorTabsMenu: ${restaurantId} - välilehteä ei löytynyt`);
    return;
  }

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const linesFromEl = ($el) => {
    const innerHtml = ($el.html() || "").replace(/<br\s*\/?>/gi, "\n");
    const text = cheerio.load(`<div>${innerHtml}</div>`)("div").first().text();
    return text.split("\n").map((l) => l.trim()).filter(Boolean);
  };

  // Kävellään otsikko+tekstieditori-widgetit järjestyksessä läpi - ne
  // vuorottelevat DOM:ssa (otsikko, sisältö, jakoviiva, otsikko, sisältö, ...)
  // riippumatta tarkasta wrapper-div-syvyydestä.
  const blocks = [];
  let currentLabel = "";
  panel.find(".elementor-widget-heading, .elementor-widget-text-editor").each((_, w) => {
    const $w = $(w);
    if ($w.hasClass("elementor-widget-heading")) {
      currentLabel = clean($w.find(".elementor-heading-title").first().text());
    } else {
      const container = $w.find(".elementor-widget-container").first();
      const lines = linesFromEl(container);
      if (lines.length) blocks.push({ label: currentLabel, lines });
    }
  });

  const prices = [];
  const rawParts = [];
  for (const block of blocks) {
    const labelLower = block.label.toLowerCase();
    if (labelLower.includes("allergia")) continue; // sama legenda joka päivä, ei tarpeen

    if (labelLower === "hinta") {
      block.lines.forEach((line) => {
        const m = line.match(/^(.+?):\s*([\d,.]+)\s*€/);
        if (m) prices.push({ label: clean(m[1]), price: m[2] + " €" });
      });
    }
    rawParts.push(block.lines.join("\n"));
  }

  const rawText = rawParts.join("\n\n");
  if (!rawText) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: "Tämän päivän välilehti löytyi, mutta siitä ei saatu poimittua yhtään sisältöä.",
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneElementorTabsMenu: ${restaurantId} - tyhjä sisältö`);
    return;
  }

  await ref.set({
    restaurantId,
    date: dateIso,
    parseStatus: "partial",
    prices,
    rawText,
    checkedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logger.info(`syncOneElementorTabsMenu: ${restaurantId} - tallennettu onnistuneesti`);
}

// ---------------------------------------------------------------------------
// 10. Elementor "yksi pitkä lista" -viikkolista (eri rakenne kuin
//     elementortabs: EI erillisiä välilehtiä per päivä, vaan koko viikko
//     yhtenä pitkänä <p>-rivien listana samassa tekstieditori-widgetissä,
//     päivät erotettu vain tavallisilla "Maanantai 28.9."-tyylisillä riveillä)
// ---------------------------------------------------------------------------
// Etsitään ensin OIKEA tekstieditori-widget sivulta (sivulla voi olla monta) -
// valitaan se jossa on eniten viikonpäivä-alkuisia <p>-rivejä. Sen sisällä
// segmentoidaan tämän päivän rivit siihen asti kunnes seuraava viikonpäivärivi
// alkaa. Hinnat haetaan erikseen MUISTA tekstieditori-widgeteistä (usein oma
// "Lounaan hinnat" -laatikkonsa), koska ne eivät ole päiväkohtaisia tässä
// rakenteessa. HUOM sivun teksti sisältää näkymättömiä pehmeitä
// tavutusmerkkejä (U+00AD) sanojen sisällä - ne pitää siivota pois ennen
// viikonpäivien tunnistusta, muuten "Maa­nan­tai" ei täsmää "Maanantai"in.
async function syncOneElementorFlatListMenu(restaurantId, sourceData, region = REGIONS.tampere) {
  const url = sourceData.url;
  const dateIso = new Date().toISOString().slice(0, 10);
  const ref = db.collection(region.dailyMenus).doc(`${restaurantId}_${dateIso}`);

  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} haettaessa ${url}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  // Poistetaan pehmeät tavutusmerkit (U+00AD) ja siistitään välilyönnit.
  const clean = (s) => String(s || "").replace(/\u00ad/g, "").replace(/\s+/g, " ").trim();

  const FI_WEEKDAYS = ["Maanantai", "Tiistai", "Keskiviikko", "Torstai", "Perjantai", "Lauantai", "Sunnuntai"];
  const dayLineRe = new RegExp(`^(${FI_WEEKDAYS.join("|")})\\s+(\\d{1,2})\\.(\\d{1,2})\\.?\\s*$`);
  const todayIdx = new Date().getDay(); // 0=su...6=la
  const todayWeekdayName = ["Sunnuntai", "Maanantai", "Tiistai", "Keskiviikko", "Torstai", "Perjantai", "Lauantai"][todayIdx];

  // 1) Etsitään OIKEA widget: se jossa on eniten viikonpäivä-rivejä.
  let bestParagraphs = null;
  let bestScore = 0;
  let bestWidgetEl = null;
  const allWidgets = $(".elementor-widget-text-editor .elementor-widget-container");
  allWidgets.each((_, w) => {
    const paragraphs = $(w).find("p").toArray().map((p) => clean($(p).text())).filter(Boolean);
    const score = paragraphs.filter((p) => dayLineRe.test(p)).length;
    if (score > bestScore) {
      bestScore = score;
      bestParagraphs = paragraphs;
      bestWidgetEl = w;
    }
  });

  if (!bestParagraphs || bestScore === 0) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: "Sivulta ei löytynyt viikonpäivä-rivejä sisältävää tekstieditori-widgettiä.",
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneElementorFlatListMenu: ${restaurantId} - ei löytynyt menu-widgettiä`);
    return;
  }

  // 2) Poimitaan tämän päivän rivit siihen asti kunnes seuraava viikonpäivärivi alkaa.
  const dishLines = [];
  let collecting = false;
  for (const p of bestParagraphs) {
    const isDayLine = dayLineRe.test(p);
    if (isDayLine) {
      if (collecting) break; // seuraava päivä alkoi -> lopetetaan
      if (p.startsWith(todayWeekdayName)) collecting = true;
      continue;
    }
    if (collecting) dishLines.push(p);
  }

  if (dishLines.length === 0) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: `Menu-widget löytyi, mutta tämän päivän (${todayWeekdayName}) riviä ei löytynyt siitä.`,
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneElementorFlatListMenu: ${restaurantId} - tämän päivän rivejä ei löytynyt`);
    return;
  }

  // 3) Hinnat MUISTA tekstieditori-widgeteistä (usein oma "Lounaan hinnat"
  // -laatikko, ei päiväkohtainen). Poimitaan "Label X,XX €" -tyyliset rivit.
  const prices = [];
  allWidgets.each((_, w) => {
    if (w === bestWidgetEl) return;
    $(w).find("li").each((_, li) => {
      const line = clean($(li).text());
      const m = line.match(/^(.+?)\s+(\d+[,.]\d+)\s*€/);
      if (m) prices.push({ label: m[1].trim(), price: m[2] + " €" });
    });
  });

  const rawText = dishLines.join("\n");

  await ref.set({
    restaurantId,
    date: dateIso,
    parseStatus: "partial",
    prices,
    rawText,
    checkedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logger.info(`syncOneElementorFlatListMenu: ${restaurantId} - tallennettu onnistuneesti`);
}

// ---------------------------------------------------------------------------
// 11. Antell (ravintolaketju, kattaa monia toimipisteitä eri puolilla Suomea)
// ---------------------------------------------------------------------------
// Rakenne: <section id="panel-Monday">..<section id="panel-Friday"> (ei
// viikonloppua). Jokainen sisältää ".tabpanel__buffet" (kategorioittain
// jaoteltu lounasbuffet: Pääruoaksi/Pääruoan kaveriksi/Jälkiruoaksi, ei omaa
// hintaa per kategoria - kokonaishinta on erikseen ".tabpanel__header"issa)
// ja ".tabpanel__specials" (erilliset lisävaihtoehdot kuten Grilliannos/
// Delilounas/Pizzalounas, joilla KULLAKIN on oma hintansa). Molemmat
// käyttävät samaa ".option-title" (nimi + valinnainen hinta) + seuraava
// "ul.accordion__list" (ruokalajit, joissa nimi + allergeenimerkinnät)
// -rakennetta, joten sama silmukka käsittelee molemmat kerralla.
async function syncOneAntellMenu(restaurantId, sourceData, region = REGIONS.tampere) {
  const url = sourceData.url;
  const dateIso = new Date().toISOString().slice(0, 10);
  const ref = db.collection(region.dailyMenus).doc(`${restaurantId}_${dateIso}`);

  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} haettaessa ${url}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const ENGLISH_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const todayName = ENGLISH_WEEKDAYS[new Date().getDay()];

  const panel = $(`#panel-${todayName}`);
  if (!panel.length) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: `Tämän päivän (${todayName}) paneelia ei löytynyt sivulta - ravintola on ehkä kiinni tänään (esim. viikonloppu).`,
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneAntellMenu: ${restaurantId} - paneelia ei löytynyt (${todayName})`);
    return;
  }

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const prices = [];
  const rawSections = [];

  panel.find(".option-title").each((_, optEl) => {
    const $opt = $(optEl);
    const label = clean($opt.find("h5").first().text());
    if (!label) return;

    const priceText = clean($opt.find("h5.option-price").text());
    if (priceText) prices.push({ label, price: priceText });

    const list = $opt.siblings("ul.accordion__list").first();
    const lines = [];
    list.find("> li").each((_, li) => {
      const $li = $(li);
      const name = clean($li.find(".accordion__button").first().text());
      const diets = clean($li.find(".accordion__footer__special-diets p").first().text());
      if (name) lines.push(diets ? `${name} (${diets})` : name);
    });
    if (lines.length) rawSections.push([label, ...lines].join("\n"));
  });

  // Buffetin oma kokonaishinta (esim. "Lounasbuffet 13,80 €") on erillään
  // yllä olevasta option-title-rakenteesta, ".tabpanel__header"issa.
  panel.find(".tabpanel__header").each((_, hdr) => {
    const $hdr = $(hdr);
    const title = clean($hdr.find(".tabpanel__header__title").text());
    const price = clean($hdr.find(".tabpanel__header__price").text());
    if (title && price) prices.unshift({ label: title, price });
  });

  const rawText = rawSections.join("\n\n");
  if (!rawText) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: `Tämän päivän (${todayName}) paneeli löytyi, mutta siitä ei saatu poimittua yhtään sisältöä.`,
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneAntellMenu: ${restaurantId} - tyhjä sisältö`);
    return;
  }

  await ref.set({
    restaurantId,
    date: dateIso,
    parseStatus: "partial",
    prices,
    rawText,
    checkedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logger.info(`syncOneAntellMenu: ${restaurantId} - tallennettu onnistuneesti`);
}

// ---------------------------------------------------------------------------
// 12. Jamix Cloud (opiskelijaravintolat, mm. Juvenes - kattaa monta ravintolaa)
// ---------------------------------------------------------------------------
// Itse sivu on tyhjä JavaScript-sovelluskuori, mutta Jamixilla on julkinen
// JSON-rajapinta erillään siitä: .../rest/haku/menu/<customerID>/<kitchenID>.
// "url"-kenttään tallennetaan suoraan tämä rajapinnan osoite, JA mt=<id>
// -kyselyparametri kertoo MEILLE (ei palvelimelle - se ohittaa sen) minkä
// menuTypeId:n alta data haetaan, koska yhdellä keittiöllä on usein monta
// rinnakkaista listaa (esim. "Henkilöstölounas", "Lounas", "Yläkuppila").
// JSON sisältää AINA kaikki menuTypet riippumatta mt-parametrista, joten
// suodatus tehdään meidän puolellamme vastauksen saavuttua.
async function syncOneJamixMenu(restaurantId, sourceData, region = REGIONS.tampere) {
  const url = sourceData.url;
  const dateIso = new Date().toISOString().slice(0, 10);
  const dateCompact = parseInt(dateIso.replace(/-/g, ""), 10); // esim. 20261001
  const ref = db.collection(region.dailyMenus).doc(`${restaurantId}_${dateIso}`);

  let targetMenuTypeId = null;
  try {
    targetMenuTypeId = parseInt(new URL(url).searchParams.get("mt"), 10);
    if (Number.isNaN(targetMenuTypeId)) targetMenuTypeId = null;
  } catch (e) {
    targetMenuTypeId = null;
  }

  const res = await fetchWithTimeout(url, {
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} haettaessa ${url}`);

  let data;
  try {
    data = JSON.parse(await res.text());
  } catch (err) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: `Jamixin vastaus ei ollut kelvollista JSON:ia: ${err.message}`,
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneJamixMenu: ${restaurantId} - JSON.parse epäonnistui`);
    return;
  }

  const kitchen = Array.isArray(data) ? data[0] : null;
  const menuTypes = (kitchen && kitchen.menuTypes) || [];
  const menuType = targetMenuTypeId
    ? menuTypes.find((mtObj) => mtObj.menuTypeId === targetMenuTypeId)
    : menuTypes.find((mtObj) => /lounas/i.test(mtObj.menuTypeName || "")); // varafallback

  if (!menuType) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: `Jamix-vastauksesta ei löytynyt haluttua menuTypeId:tä (${targetMenuTypeId}).`,
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneJamixMenu: ${restaurantId} - menuTypeId:tä ${targetMenuTypeId} ei löytynyt`);
    return;
  }

  // Yksi menuType voi sisältää useamman "menus"-kokonaisuuden (esim. eri
  // ajanjaksoille) - etsitään tämän päivän "days"-rivi mistä tahansa niistä.
  let todayEntry = null;
  for (const menu of menuType.menus || []) {
    todayEntry = (menu.days || []).find((d) => d.date === dateCompact);
    if (todayEntry) break;
  }

  if (!todayEntry) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: `Tämän päivän (${dateIso}) riviä ei löytynyt Jamixin datasta - ravintola on ehkä kiinni tänään.`,
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneJamixMenu: ${restaurantId} - tämän päivän riviä ei löytynyt`);
    return;
  }

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const rawSections = [];
  for (const option of todayEntry.mealoptions || []) {
    const label = clean(option.name);
    if (!label) continue;
    const lines = (option.menuItems || [])
      .map((item) => {
        const name = clean(item.name);
        const diets = clean(item.diets);
        return name ? (diets ? `${name} (${diets})` : name) : "";
      })
      .filter(Boolean);
    if (lines.length) rawSections.push([label, ...lines].join("\n"));
  }

  const rawText = rawSections.join("\n\n");
  if (!rawText) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: "Tämän päivän rivi löytyi, mutta siitä ei saatu poimittua yhtään sisältöä.",
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneJamixMenu: ${restaurantId} - tyhjä sisältö`);
    return;
  }

  await ref.set({
    restaurantId,
    date: dateIso,
    parseStatus: "partial",
    prices: [], // Jamixin data ei sisällä hintoja tässä rajapinnassa
    rawText,
    checkedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logger.info(`syncOneJamixMenu: ${restaurantId} - tallennettu onnistuneesti`);
}

// ---------------------------------------------------------------------------
// 13. Sodexo (ravintolaketju, päivittäiset PDF:t - sama periaate kuin
//     Poweresta: kiinteä URL-pohja jossa {date} vaihdetaan tämän päivän
//     päivämäärään ennen hakua, pdf_url_pattern-kentästä)
// ---------------------------------------------------------------------------
// HUOM: en käyttänyt sodexo.fi:n tavallisia ravintolasivuja ollenkaan, koska
// PDF-reitti on jo suoraan annettu jokaiselle ravintolalle ja on
// todennäköisesti luotettavampi (sama syy miksi Maukkaallakin aiemmin
// päädyttiin PDF:ään HTML:n sijaan). Ei vielä nähty oikeaa pdf-parse:n
// tuottamaa raakatekstiä tältä alustalta, joten tämä on ensimmäinen,
// yleispätevä versio - tarkennetaan kun nähdään oikea tulos.
async function syncOneSodexoMenu(restaurantId, sourceData, region = REGIONS.tampere) {
  const { pdfUrlPattern } = sourceData;
  const dateIso = new Date().toISOString().slice(0, 10);
  const ref = db.collection(region.dailyMenus).doc(`${restaurantId}_${dateIso}`);

  if (!pdfUrlPattern) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: 'menuSources-riviltä puuttuu "pdf_url_pattern" - Sodexo-alusta tarvitsee sen.',
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneSodexoMenu: ${restaurantId} - pdfUrlPattern puuttuu`);
    return;
  }

  const pdfUrl = pdfUrlPattern.replace("{date}", dateIso);
  const res = await fetchWithTimeout(pdfUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} haettaessa ${pdfUrl}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  let parsed;
  try {
    parsed = await pdfParse(buffer);
  } catch (err) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: `PDF:n jäsennys epäonnistui: ${err.message} - ravintolalla ei ehkä ole listaa tänään.`,
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneSodexoMenu: ${restaurantId} - pdfParse epäonnistui`);
    return;
  }

  // Yleispätevä siistiminen: siistitään rivit, poistetaan tyhjät ja
  // peräkkäiset duplikaattirivit (yleinen pdf-parse-artefakti), rajataan
  // kokoa. Ei vielä yritetä poimia hintoja rakenteisena koska emme ole
  // nähneet oikeaa tulostetta tästä lähteestä.
  const rawLines = (parsed.text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 2);
  const lines = rawLines.filter((l, i) => l !== rawLines[i - 1]);
  const rawText = lines.join("\n").slice(0, 4000);

  if (!rawText || rawText.length < 10) {
    await ref.set({
      restaurantId,
      date: dateIso,
      parseStatus: "failed",
      rawTextSnippet: "PDF haettiin, mutta siitä ei saatu poimittua tulkittavaa tekstiä.",
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.warn(`syncOneSodexoMenu: ${restaurantId} - tyhjä sisältö`);
    return;
  }

  await ref.set({
    restaurantId,
    date: dateIso,
    parseStatus: "partial",
    prices: [],
    rawText,
    checkedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logger.info(`syncOneSodexoMenu: ${restaurantId} - tallennettu (yleispätevä PDF-poiminta)`);
}

// ---------------------------------------------------------------------------
// Ajastettu: alustatietoinen dispatch
// ---------------------------------------------------------------------------
// Käy läpi kaikki menuSources-kokoelman aktiiviset lähteet ja ohjaa jokaisen
// oikealle parserille sen platform-kentän mukaan. Uuden alustan lisääminen =
// kirjoita syncOne<Alusta>Menu-funktio ja lisää sille case tähän tauluun.
const PLATFORM_HANDLERS = {
  poweresta: syncOnePowerestaMenu,
  linkosuo: syncOneLinkosuoMenu,
  generic: syncOneGenericMenu,
  quatresaisons: syncOneQuatreSaisonsMenu,
  raflaamo: syncOneRaflaamoMenu,
  compassgroup: syncOneCompassGroupMenu,
  elementortabs: syncOneElementorTabsMenu,
  elementorflatlist: syncOneElementorFlatListMenu,
  antell: syncOneAntellMenu,
  jamix: syncOneJamixMenu,
  sodexo: syncOneSodexoMenu,
};

// Eiliset ja sitä vanhemmat dailyMenus-dokumentit eivät koskaan päädy
// näkyville - sovellus hakee aina vain tämän päivän dataa
// (loadDailyMenusFromFirestore: where('date', '==', today)). Siivotaan ne
// pois joka yö ettei kokoelma kasva loputtomiin turhaan.
async function cleanupOldDailyMenus(region) {
  const todayIso = new Date().toISOString().slice(0, 10);
  // Päivämäärät ovat YYYY-MM-DD-muodossa, joten merkkijonovertailu "<" toimii
  // oikein aikajärjestyksessä.
  const snap = await db.collection(region.dailyMenus).where("date", "<", todayIso).get();
  if (snap.empty) {
    logger.info(`cleanupOldDailyMenus[${region.id}]: ei poistettavaa.`);
    return;
  }
  const docs = snap.docs;
  // Firestoren erä (batch) sallii korkeintaan 500 kirjoitusta/poistoa kerralla.
  for (let i = 0; i < docs.length; i += 500) {
    const batch = db.batch();
    docs.slice(i, i + 500).forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
  logger.info(`cleanupOldDailyMenus[${region.id}]: poistettu ${docs.length} vanhaa ${region.dailyMenus}-dokumenttia.`);
}

exports.syncDailyMenus = onSchedule(
  { schedule: "0 5 * * *", timeZone: "Europe/Helsinki", timeoutSeconds: 540 },
  async () => {
    await runAllMenuSources(REGIONS.tampere);
    await cleanupOldDailyMenus(REGIONS.tampere);
  }
);
// Helsinki: oma funktio, oma kellonaika (Tampereen ajo kestää enintään 9 min ja päättyy ennen tätä).
exports.syncDailyMenusHelsinki = onSchedule(
  { schedule: "15 5 * * *", timeZone: "Europe/Helsinki", timeoutSeconds: 540 },
  async () => {
    await runAllMenuSources(REGIONS.helsinki);
    await cleanupOldDailyMenus(REGIONS.helsinki);
  }
);

// Käsitellään useampi lähde YHTÄ AIKAA peräkkäisen silmukan sijaan - 255
// lähdettä peräkkäin (jokainen 1-15s) ylitti helposti aikarajan. Rajoitettu
// samanaikaisuus (ei kaikkia 255:tä kerralla) pitää kuorman siedettävänä sekä
// meille että kohdesivustoille.
const CONCURRENCY = 8;

async function runAllMenuSources(region) {
  const sources = await db.collection(region.menuSources).where("active", "==", true).get();
  logger.info(`runAllMenuSources[${region.id}]: ${sources.size} aktiivista lähdettä käsiteltävänä`);

  const docs = sources.docs;
  const results = new Array(docs.length);

  async function worker(startIndex) {
    for (let i = startIndex; i < docs.length; i += CONCURRENCY) {
      const doc = docs[i];
      const sourceData = doc.data();
      const { platform } = sourceData;
      const handler = PLATFORM_HANDLERS[platform];
      if (!handler) {
        logger.warn(`runAllMenuSources[${region.id}]: ${doc.id} - tuntematon platform "${platform}", ohitetaan`);
        results[i] = { id: doc.id, status: "skipped", reason: `tuntematon platform "${platform}"` };
        continue;
      }
      try {
        await handler(doc.id, sourceData, region);
        results[i] = { id: doc.id, status: "ok" };
      } catch (err) {
        logger.error(`runAllMenuSources[${region.id}]: ${doc.id} (${platform}) epäonnistui:`, err);
        results[i] = { id: doc.id, status: "error", reason: String(err) };
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, docs.length) }, (_, i) => worker(i));
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// 5. Manuaalinen laukaisin PoC-testausta varten
// ---------------------------------------------------------------------------
//
// Ajastettu funktio herää vasta klo 5 joka aamu — PoC-vaiheessa halutaan
// testata heti. Tämä HTTP-funktio tekee saman, mutta sen voi kutsua suoraan
// selaimesta milloin tahansa. Suojattu YKSINKERTAISELLA jaetulla salasanalla
// query-parametrissa, koska HTTP-funktiot ovat oletuksena julkisesti
// kutsuttavissa niiden URL:n tietäen — ilman tätä kuka tahansa internetissä
// voisi laukaista Overpass/Poweresta/Linkosuo-haut sinun piikkiisi.
//
// KÄYTTÖ: aseta oma salasana Firebase-ympäristömuuttujaksi ennen deployta:
//   firebase functions:config:set sync.secret="oma-satunnainen-salasana"
// tai (uudempi tapa, .env-tiedosto functions-kansiossa):
//   echo 'SYNC_SECRET=oma-satunnainen-salasana' >> functions/.env
//
// Kutsu sitten selaimessa:
//   https://<region>-<project>.cloudfunctions.net/syncDailyMenusManual?secret=oma-satunnainen-salasana
//
// HUOM tämä on tarkoitettu VAIN PoC/kehitysvaiheeseen. Poista tai lukitse
// tiukemmin (esim. vaadi Firebase-kirjautuminen) ennen oikeaa julkaisua.
exports.syncDailyMenusManual = onRequest({ timeoutSeconds: 540 }, (req, res) =>
  handleManualSync(req, res, "syncDailyMenusManual", async () => {
    const results = await runAllMenuSources(REGIONS.tampere);
    return { count: results.length, results };
  })
);
exports.syncDailyMenusHelsinkiManual = onRequest({ timeoutSeconds: 540 }, (req, res) =>
  handleManualSync(req, res, "syncDailyMenusHelsinkiManual", async () => {
    const results = await runAllMenuSources(REGIONS.helsinki);
    return { count: results.length, results };
  })
);

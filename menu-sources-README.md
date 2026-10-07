# menu-sources.csv — ohje

Tähän tiedostoon lisätään yksi rivi per ravintola, jolta lounaslista haetaan
automaattisesti. Täytä Excelissä/Google Sheetsissä ja tallenna CSV-muotoon
(tai muokkaa suoraan tekstieditorissa).

## Säännöt mitä lisätään

- **Ei PDF-vain-ravintoloita.** Jos ravintolan lounaslista on saatavilla
  VAIN PDF- tai kuvamuodossa (ei tavallisena HTML-tekstinä sivulla), älä
  lisää sitä tähän tiedostoon. PDF/kuva vaatisi eri tekniikan (tekstin
  erotus PDF:stä tai OCR), joka on jätetty tämän vaiheen ulkopuolelle.
  Nämä ravintolat saavat toistaiseksi vain "Lounaslista ↗"-linkin
  sovelluksessa, kuten kaikki muutkin.
- Jos sivulla on SEKÄ tavallinen HTML-teksti ETTÄ PDF-latauslinkki (kuten
  Linkosuon sivuilla), se KELPAA — kunhan HTML-versio sisältää oikean
  lounaslistan, ei vain linkin PDF:ään.

## Sarakkeet

| Sarake | Pakollinen | Selitys |
|---|---|---|
| `restaurant_id` | Kyllä | Oltava sama id kuin `restaurants`-kokoelmassa (esim. `node/12345`). Jos et tiedä sitä ulkoa, hae ravintola Firebase Consolen `restaurants`-kokoelmasta nimellä ja kopioi dokumentin id. |
| `name` | Ei (vain muistiinpano) | Ravintolan nimi, helpottaa rivien tunnistamista taulukossa. |
| `url` | Kyllä | Sivu jolta lounaslista löytyy (ankkurilinkki #lounaslista tms. käy hyvin). |
| `platform` | Ei | `poweresta` jos tunnistat alustan, muuten jätä tyhjäksi — täytetään myöhemmin kun alusta on tunnistettu/parseri kirjoitettu. |
| `active` | Kyllä | `TRUE` = otetaan mukaan seuraavassa synkronoinnissa. `FALSE` = rivi odottaa (esim. parseria ei vielä ole kyseiselle alustalle). |
| `pdf_url_pattern` | Vain Poweresta-ravintoloille | Päivittäisen PDF-lounaslistan osoite, jossa päivämäärän kohdalla on kirjaimellisesti `{date}`, esim. `https://www.ninankeittio.fi/wp-content/uploads/poweresta/tammela-ruokalistat-{date}-fi.pdf`. Löydät tämän avaamalla ravintolan sivun ja katsomalla minkä osoitteen "PDF"-linkki tarjoaa. Jätä tyhjäksi muille alustoille (esim. Linkosuo). |
| `notes` | Ei | Vapaa muistiinpano itsellesi, esim. miksi active=FALSE. |

## Miten tämä viedään Firestoreen

Kun tiedosto on täytetty, aja samassa kansiossa:

```bash
node import-menu-sources.js menu-sources.csv
```

Skripti lukee CSV:n ja kirjoittaa/päivittää jokaisen rivin
`menuSources/{restaurant_id}`-dokumentiksi Firestoreen. Voit ajaa saman
komennon uudelleen milloin tahansa lisättyäsi uusia rivejä — se päivittää
olemassa olevat eikä tee duplikaatteja (dokumentin id on aina
`restaurant_id`).

Tarvitset ensin palvelutilin avaimen (Firebase Console -> Project settings
-> Service accounts -> Generate new private key), tallenna se samaan
kansioon nimellä `serviceAccountKey.json` (älä koskaan committaa tätä
tiedostoa versionhallintaan).

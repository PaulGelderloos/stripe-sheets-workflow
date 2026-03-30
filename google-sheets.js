const { google } = require("googleapis");
const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
const auth = new google.auth.GoogleAuth({
  credentials: credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

async function syncToGoogleSheets(paymentIntent) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  // Mollie betalingen hebben geen .id maar wel metadata.referentie
  const isMollie = !paymentIntent.id && !!paymentIntent.metadata?.referentie;
  const sheetName = isMollie ? "Betalingen" : (paymentIntent.metadata?.sheet_name || "Betalingen");

  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `'${sheetName}'!1:1`,
  });
  const headers = headerRes.data.values?.[0] || [];
  console.log("Headers gelezen:", JSON.stringify(headers));

  const rowData = isMollie
    ? mapMollieToColumns(paymentIntent, headers)
    : mapPaymentToColumns(paymentIntent, headers);
  console.log("RowData gemaakt:", JSON.stringify(rowData));

  // Determine next empty row explicitly via column A to avoid
  // Google's table-detection placing data in the wrong column
  const colARes = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `'${sheetName}'!A:A`,
  });
  const nextRow = (colARes.data.values?.length || 0) + 1;

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `'${sheetName}'!A${nextRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [rowData] },
  });

  const ref = isMollie ? paymentIntent.metadata.referentie : paymentIntent.id;
  console.log(`Betaling ${ref} toegevoegd aan '${sheetName}' rij ${nextRow}`);
}

// Case-insensitive header matching helper
function mapToRow(fieldMap, headers) {
  const lowerMap = {};
  for (const [key, value] of Object.entries(fieldMap)) {
    lowerMap[key.toLowerCase().trim()] = value;
  }
  return headers.map((header) => lowerMap[header.toLowerCase().trim()] ?? "");
}

// ── Stripe ────────────────────────────────────────────
function mapPaymentToColumns(payment, headers) {
  const fieldMap = {
    "payment id":           payment.id,
    "status":               payment.status,
    "naam cursus":          payment.metadata?.sheet_name || "",
    "bedrag":               (payment.amount / 100).toFixed(2),
    "totaal verschuldigd":  (payment.amount / 100).toFixed(2),
    "valuta":               payment.currency?.toUpperCase() || "",
    "e-mail":               payment.metadata?.email || payment.receipt_email || "",
    "volledige naam":       payment.metadata?.name || "",
    "actiecode":            payment.metadata?.actiecode || "",
    "betaalmethode":        payment.payment_method_types?.join(", ") || "",
    "accommodatie":         payment.metadata?.accommodatie || "",
    "aangemaakt":           new Date(payment.created * 1000).toLocaleString("nl-NL"),
    "cursusdatum":          payment.metadata?.cursusdatum || "",
  };
  return mapToRow(fieldMap, headers);
}

// ── Mollie ────────────────────────────────────────────
function mapMollieToColumns(payment, headers) {
  const m = payment.metadata || {};
  const fieldMap = {
    "payment id":           m.referentie       || "",
    "status":               "paid",
    "naam cursus":          m.cursus            || "",
    "bedrag":               m.bedragIncl        || "",
    "totaal verschuldigd":  m.bedragIncl        || "",
    "bedrag excl btw":      m.bedragExcl        || "",
    "bedrag excl. btw":     m.bedragExcl        || "",
    "valuta":               "EUR",
    "e-mail":               m.email             || "",
    "volledige naam":       m.naam              || "",
    "telefoonnummer":       m.telefoon          || "",
    "betaalmethode":        m.methode           || "",
    "centrum":              m.centrum           || "",
    "tarief":               m.tarief            || "",
    "aangemaakt":           m.datum             || new Date().toLocaleString("nl-NL"),
    "cursusdatum":          m.cursusdatum       || "",
    "partner naam":         m.partner_voornaam && m.partner_achternaam
                              ? `${m.partner_voornaam} ${m.partner_achternaam}` : "",
    "partner e-mail":       m.partner_email     || "",
  };
  return mapToRow(fieldMap, headers);
}

module.exports = { syncToGoogleSheets };

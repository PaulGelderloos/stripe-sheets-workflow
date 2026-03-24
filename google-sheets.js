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
  console.log('Headers gelezen:', JSON.stringify(headers));

  const rowData = isMollie
    ? mapMollieToColumns(paymentIntent, headers)
    : mapPaymentToColumns(paymentIntent, headers);
  console.log('RowData gemaakt:', JSON.stringify(rowData));

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

// ── Stripe ────────────────────────────────────────────
function mapPaymentToColumns(payment, headers) {
  const fieldMap = {
    "Payment ID":           payment.id,
    "Status":               payment.status,
    "Naam cursus":          payment.metadata?.sheet_name || "",
    "Bedrag":               (payment.amount / 100).toFixed(2),
    "Totaal verschuldigd":  (payment.amount / 100).toFixed(2),
    "Valuta":               payment.currency?.toUpperCase() || "",
    "E-mail":               payment.metadata?.email || payment.receipt_email || "",
    "Volledige naam":       payment.metadata?.name || "",
    "Actiecode":            payment.metadata?.actiecode || "",
    "Betaalmethode":        payment.payment_method_types?.join(", ") || "",
    "Accommodatie":         payment.metadata?.accommodatie || "",
    "Aangemaakt":           new Date(payment.created * 1000).toLocaleString("nl-NL"),
    "Cursusdatum":          payment.metadata?.cursusdatum || "",
  };
  
  return headers.map((header) => fieldMap[header.trim()] || "");
}

// ── Mollie ────────────────────────────────────────────
function mapMollieToColumns(payment, headers) {
  const m = payment.metadata || {};
  const fieldMap = {
    "Payment ID":           m.referentie      || "",
    "Status":               "paid",
    "Naam cursus":          m.cursus           || "",
    "Bedrag":               m.bedragIncl       || "",
    "Totaal verschuldigd":  m.bedragIncl       || "",
    "Bedrag excl. BTW":     m.bedragExcl       || "",
    "Valuta":               "EUR",
    "E-mail":               m.email            || "",
    "Volledige naam":       m.naam             || "",
    "Telefoonnummer":       m.telefoon         || "",
    "Betaalmethode":        m.methode          || "",
    "Centrum":              m.centrum          || "",
    "Tarief":               m.tarief           || "",
    "Aangemaakt":           m.datum            || new Date().toLocaleString("nl-NL"),
    "Cursusdatum":          m.cursusdatum      || "",
    // Partnervelden
    "Partner naam":         m.partner_voornaam && m.partner_achternaam
                              ? `${m.partner_voornaam} ${m.partner_achternaam}` : "",
    "Partner e-mail":       m.partner_email    || "",
  };
  return headers.map((header) => fieldMap[header] ?? "");
}

module.exports = { syncToGoogleSheets };

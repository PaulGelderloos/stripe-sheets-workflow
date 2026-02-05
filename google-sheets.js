const { google } = require("googleapis");

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

const auth = new google.auth.GoogleAuth({
  credentials: credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

async function syncToGoogleSheets(paymentIntent) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetName = paymentIntent.metadata?.sheet_name || "Betalingen";
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `'${sheetName}'!1:1`,
  });
  const headers = headerRes.data.values?.[0] || [];
  const rowData = mapPaymentToColumns(paymentIntent, headers);
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `'${sheetName}'!A:Z`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [rowData] },
  });
  console.log(`Betaling ${paymentIntent.id} toegevoegd aan sheet '${sheetName}'`);
}

function mapPaymentToColumns(payment, headers) {
  const fieldMap = {
    "Payment ID":           payment.id,
    "Status":               payment.status,
    "Naam cursus":          payment.metadata?.sheet_name || "",
    "Bedrag":               (payment.amount / 100).toFixed(2),
    "Totaal verschuldigd":  (payment.amount / 100).toFixed(2),
    "Valuta":               payment.currency?.toUpperCase(),
    "E-mail":               payment.metadata?.email || payment.receipt_email || "",
    "Volledige naam":       payment.metadata?.name || "",
    "Actiecode":            payment.metadata?.actiecode || "",
    "Accommodatie":         payment.metadata?.accommodatie || "",
    "Betaalmethode":        payment.payment_method_types?.join(", ") || "",
    "Aangemaakt":           new Date(payment.created * 1000).toLocaleString("nl-NL"),
    "Cursusdatum":          payment.metadata?.cursusdatum || "",
  };
  return headers.map((header) => fieldMap[header] ?? "");
}

module.exports = { syncToGoogleSheets };

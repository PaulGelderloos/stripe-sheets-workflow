const { google } = require("googleapis");

const auth = new google.auth.GoogleAuth({
  keyFile: "./service-account.json",
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
    "Payment ID":      payment.id,
    "Status":          payment.status,
    "Bedrag":          (payment.amount / 100).toFixed(2),
    "Valuta":          payment.currency?.toUpperCase(),
    "Beschrijving":    payment.description || "",
    "Klant ID":        payment.customer || "",
    "E-mail":          payment.metadata?.email || "",
    "Naam":            payment.metadata?.name || "",
    "Product":         payment.metadata?.product || "",
    "Aangemaakt":      new Date(payment.created * 1000).toLocaleString("nl-NL"),
    "Betaalmethode":   payment.payment_method_types?.join(", ") || "",
    "Risico":          payment.risk_level || "normal",
  };
  return headers.map((header) => fieldMap[header] ?? "");
}

module.exports = { syncToGoogleSheets };

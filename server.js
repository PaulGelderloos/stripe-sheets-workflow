// v13 - Fix phone E.164 formatting for In3 orders
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message, err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err.message, err.stack);
});

require("dotenv").config();
const express  = require("express");
const cors     = require("cors");

const app = express();
app.use(cors());

// ── Status check ───────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", version: "v12" });
});
Nieuw (SMTP via nodemailer):
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_Port) || 587,
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendMail({ to, subject, html }) {
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject,
    html,
  });
  console.log(`✓ E-mail verstuurd via SMTP naar: ${to}`);
}


// ── Stripe setup (alleen als keys aanwezig) ────────────
let stripe, syncToGoogleSheets;
if (process.env.STRIPE_SECRET_KEY) {
  stripe             = require("stripe")(process.env.STRIPE_SECRET_KEY);
  syncToGoogleSheets = require("./google-sheets").syncToGoogleSheets;

  app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const sig   = req.headers["stripe-signature"];
      const event = stripe.webhooks.constructEvent(
        req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log(`Stripe event: ${event.type}`);

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        const customFields = {};
        if (session.custom_fields) {
          session.custom_fields.forEach(field => {
            if (field.dropdown?.value) {
              customFields[field.key] = field.dropdown.options.find(
                opt => opt.value === field.dropdown.value
              )?.label || field.dropdown.value;
            } else if (field.text?.value) {
              customFields[field.key] = field.text.value;
            }
          });
        }
        console.log("Stripe custom_fields keys:", JSON.stringify(customFields));

        const paymentData = {
          id:                   session.payment_intent,
          status:               session.payment_status,
          amount:               session.amount_total,
          currency:             session.currency,
          created:              session.created,
          payment_method_types: session.payment_method_types || [],
          metadata: {
            ...session.metadata,
            ...customFields,
            email: session.customer_details?.email || session.metadata?.email,
            name:  session.customer_details?.name  || session.metadata?.name,
          },
        };

        await syncToGoogleSheets(paymentData);
        console.log(`Stripe betaling verwerkt`);
      }

      res.json({ received: true });
    } catch (err) {
      console.error("Stripe webhook error:", err.message, err.stack);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  });
} else {
  console.warn("⚠ STRIPE_SECRET_KEY niet gevonden - Stripe webhooks uitgeschakeld");
}

// ── Mollie setup (alleen als keys aanwezig) ────────────
let mollie;
if (process.env.MOLLIE_API_KEY) {
  try {
    const { createMollieClient } = require("@mollie/api-client");
    mollie = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });

    if (!syncToGoogleSheets) {
      syncToGoogleSheets = require("./google-sheets").syncToGoogleSheets;
    }

    const jsonParser = express.json();

    // ── HubSpot subscription ID cache ─────────────────
    let cachedSubscriptionId = null;

    async function getSubscriptionId() {
      if (cachedSubscriptionId) return cachedSubscriptionId;
      try {
        const res  = await fetch("https://api-eu1.hubapi.com/communication-preferences/v3/definitions", {
          headers: { Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}` },
        });
        const data = await res.json();
        const marketing = data.subscriptionDefinitions?.find(s =>
          s.name.toLowerCase().includes("marketing")
        );
        cachedSubscriptionId = (marketing || data.subscriptionDefinitions?.[0])?.id || null;
        console.log(`✓ HubSpot subscription ID gecached: ${cachedSubscriptionId}`);
      } catch (err) {
        console.error("Subscription ID ophalen mislukt:", err.message);
      }
      return cachedSubscriptionId;
    }

    // ── HubSpot helpers ────────────────────────────────

    const CONTACT_PROPS = [
      "leraar_email", "voornaam_leraar", "centrum_naam",
      "cursus_tijdslot", "plaats_instructie", "initiatie_datum",
      "taal_nlen", "firstname", "lastname", "phone",
    ].join(",");

    async function getHubSpotContact(contactId) {
      if (!process.env.HUBSPOT_PRIVATE_APP_TOKEN || !contactId) return null;
      try {
        const res  = await fetch(
          `https://api-eu1.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=${CONTACT_PROPS}`,
          { headers: { Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}` } }
        );
        const data = await res.json();
        if (!res.ok) { console.error("HubSpot contact ophalen mislukt:", data); return null; }
        return { id: contactId, properties: data.properties };
      } catch (err) {
        console.error("getHubSpotContact error:", err.message);
        return null;
      }
    }

    async function getHubSpotContactByEmail(email) {
      if (!process.env.HUBSPOT_PRIVATE_APP_TOKEN || !email) return null;
      try {
        const res  = await fetch("https://api-eu1.hubapi.com/crm/v3/objects/contacts/search", {
          method:  "POST",
          headers: {
            Authorization:  `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
            properties: CONTACT_PROPS.split(","),
            limit: 1,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.results?.length) {
          if (!res.ok) console.error("HubSpot search mislukt:", res.status, JSON.stringify(data));
          return null;
        }
        const c = data.results[0];
        console.log(`✓ HubSpot contact gevonden via e-mail: ${email} → ${c.id}`);
        return { id: c.id, properties: c.properties };
      } catch (err) {
        console.error("getHubSpotContactByEmail error:", err.message);
        return null;
      }
    }

    async function updateHubSpotContact(contactId, properties) {
      if (!process.env.HUBSPOT_PRIVATE_APP_TOKEN || !contactId) return null;
      try {
        const res  = await fetch(`https://api-eu1.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
          method:  "PATCH",
          headers: {
            Authorization:  `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ properties }),
        });
        const data = await res.json();
        if (!res.ok) console.error("HubSpot update mislukt:", data);
        else console.log(`✓ HubSpot contact ${contactId} bijgewerkt`);
        return data;
      } catch (err) {
        console.error("HubSpot update error:", err.message);
        return null;
      }
    }

    async function createHubSpotContact(properties) {
      if (!process.env.HUBSPOT_PRIVATE_APP_TOKEN) return null;
      try {
        const res  = await fetch("https://api-eu1.hubapi.com/crm/v3/objects/contacts", {
          method:  "POST",
          headers: {
            Authorization:  `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ properties }),
        });
        const data = await res.json();
        if (!res.ok) console.error("HubSpot contact aanmaken mislukt:", data);
        return data;
      } catch (err) {
        console.error("HubSpot create error:", err.message);
        return null;
      }
    }

    async function setSoftOptIn(email) {
      if (!process.env.HUBSPOT_PRIVATE_APP_TOKEN || !email) return;
      try {
        const subscriptionId = await getSubscriptionId();
        if (!subscriptionId) {
          console.error("Soft Opt-in overgeslagen — geen subscription ID");
          return;
        }
        const res = await fetch("https://api-eu1.hubapi.com/communication-preferences/v3/subscribe", {
          method:  "POST",
          headers: {
            Authorization:  `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            emailAddress:          email,
            subscriptionId:        subscriptionId,
            legalBasis:            "LEGITIMATE_INTEREST_CLIENT",
            legalBasisExplanation: "Cursist heeft betaald voor een TM-cursus",
          }),
        });
        if (res.ok) console.log(`✓ Soft Opt-in ingesteld: ${email}`);
        else {
          const err = await res.json();
          if (err.category === "VALIDATION_ERROR" && err.message?.includes("already subscribed")) {
            console.log(`✓ Soft Opt-in: ${email} was al ingeschreven`);
          } else {
            console.error("Soft Opt-in mislukt:", err);
          }
        }
      } catch (err) {
        console.error("setSoftOptIn error:", err.message);
      }
    }

    // ── E-mail helpers ─────────────────────────────────

    function formatBedrag(bedrag) {
      return "€\u00a0" + parseFloat(bedrag).toFixed(2).replace(".", ",");
    }

    function formatDatum(dateStr) {
      if (!dateStr) return "";
      return new Date(dateStr).toLocaleDateString("nl-NL", {
        day: "numeric", month: "long", year: "numeric",
      });
    }

    function maakFactuurNummer(mollieId) {
      const year = new Date().getFullYear();
      const ref  = String(mollieId).replace(/[^0-9]/g, "").slice(-5).padStart(5, "0");
      return `TM-${year}-${ref}`;
    }

    async function stuurBevestigingCursist(data) {
      const {
        naam, email, centrum, cursusnaam, initiatieDatum,
        tijdslot, locatie, bedragIncl, methode, mollieId, taal,
      } = data;

      if (!email) return;

      const factuurNr = maakFactuurNummer(mollieId);
      const vandaag   = new Date().toLocaleDateString("nl-NL", {
        day: "numeric", month: "long", year: "numeric",
      });
      const isEN    = taal === "EN";
      const subject = isEN
        ? `Confirmation TM Course — ${cursusnaam || centrum}`
        : `Bevestiging TM cursus — ${cursusnaam || centrum}`;

      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f5f5f5;">
<div style="max-width:600px;margin:32px auto;background:white;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

  <div style="background:#1a3a5c;padding:28px 32px;">
    <h1 style="margin:0;color:white;font-size:22px;font-weight:600;">
      ${isEN ? "Confirmation of your TM Course" : "Bevestiging van je TM cursus"}
    </h1>
    <p style="margin:8px 0 0;color:rgba(255,255,255,0.8);font-size:14px;">
      ${isEN ? "Invoice" : "Factuur"} ${factuurNr} &middot; ${vandaag}
    </p>
  </div>

  <div style="padding:32px;">
    <p style="color:#333;font-size:15px;margin-top:0;">
      ${isEN ? `Dear ${naam},` : `Beste ${naam},`}
    </p>
    <p style="color:#555;font-size:14px;line-height:1.6;">
      ${isEN
        ? "Thank you for your registration and payment. We look forward to welcoming you to your TM course!"
        : "Hartelijk dank voor je aanmelding en betaling. We kijken ernaar uit je te verwelkomen bij je TM cursus!"}
    </p>

    <table style="width:100%;border-collapse:collapse;margin:24px 0;font-size:14px;">
      ${initiatieDatum ? `<tr style="border-bottom:1px solid #eee;">
        <td style="padding:10px 0;color:#888;width:40%;">${isEN ? "Start date" : "Startdatum"}</td>
        <td style="padding:10px 0;color:#333;font-weight:600;">${formatDatum(initiatieDatum)}</td>
      </tr>` : ""}
      ${tijdslot ? `<tr style="border-bottom:1px solid #eee;">
        <td style="padding:10px 0;color:#888;">${isEN ? "Time" : "Tijden"}</td>
        <td style="padding:10px 0;color:#333;">${tijdslot}</td>
      </tr>` : ""}
      ${centrum ? `<tr style="border-bottom:1px solid #eee;">
        <td style="padding:10px 0;color:#888;">${isEN ? "Centre" : "Centrum"}</td>
        <td style="padding:10px 0;color:#333;">${centrum}</td>
      </tr>` : ""}
      ${locatie ? `<tr style="border-bottom:1px solid #eee;">
        <td style="padding:10px 0;color:#888;">${isEN ? "Location" : "Locatie"}</td>
        <td style="padding:10px 0;color:#333;">${locatie}</td>
      </tr>` : ""}
    </table>

    <div style="background:#f8f9fa;border-radius:6px;padding:20px;margin:24px 0;">
      <p style="margin:0 0 12px;color:#333;font-weight:600;font-size:14px;">
        ${isEN ? "Invoice" : "Factuur"} ${factuurNr}
      </p>
      <table style="width:100%;font-size:14px;">
        <tr>
          <td style="color:#555;padding:4px 0;">${cursusnaam || (isEN ? "TM Course" : "TM Cursus")}</td>
          <td style="color:#333;text-align:right;font-weight:600;">${formatBedrag(bedragIncl)}</td>
        </tr>
        <tr>
          <td colspan="2" style="padding-top:12px;border-top:1px solid #ddd;color:#888;font-size:12px;">
            ${isEN ? "VAT exempt (Art. 11.1.o Dutch VAT Act 1968)" : "BTW vrijgesteld (art. 11.1.o Wet OB 1968)"}
          </td>
        </tr>
      </table>
    </div>

    <p style="color:#555;font-size:13px;line-height:1.6;">
      ${isEN
        ? 'Questions? Contact us at <a href="mailto:nationaal@transcendentemeditatie.com" style="color:#1a3a5c;">nationaal@transcendentemeditatie.com</a>.'
        : 'Vragen? Neem contact op via <a href="mailto:nationaal@transcendentemeditatie.com" style="color:#1a3a5c;">nationaal@transcendentemeditatie.com</a>.'}
    </p>
  </div>

  <div style="background:#f5f5f5;padding:16px 32px;text-align:center;">
    <p style="margin:0;color:#999;font-size:12px;">
      TM Nederland &middot; <a href="https://www.tm.nl" style="color:#999;">tm.nl</a>
    </p>
  </div>

</div>
</body></html>`;

      await sendMail({ to: email, subject, html });
      console.log(`✓ Bevestigingsmail verstuurd naar: ${email}`);
    }

    async function stuurLeraarsNotificatie(data) {
      const {
        leraarEmail, voornaamLeraar, cursistNaam, cursistEmail,
        cursistTelefoon, centrum, initiatieDatum, tijdslot,
        locatie, cursusnaam, bedragIncl, methode,
      } = data;

      if (!leraarEmail) {
        console.log("Geen leraar-email — notificatie overgeslagen");
        return;
      }

      const aanhef  = voornaamLeraar ? `Beste ${voornaamLeraar},` : "Beste leraar,";
      const vandaag = new Date().toLocaleString("nl-NL", {
        day: "numeric", month: "long", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });

      const rij = (label, waarde, shaded) => waarde ? `
      <tr${shaded ? ' style="background:#f8f9fa;"' : ""}>
        <td style="padding:10px 12px;color:#888;width:38%;border-top:1px solid #eee;">${label}</td>
        <td style="padding:10px 12px;color:#333;border-top:1px solid #eee;">${waarde}</td>
      </tr>` : "";

      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f5f5f5;">
<div style="max-width:600px;margin:32px auto;background:white;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

  <div style="background:#1a3a5c;padding:24px 32px;">
    <h2 style="margin:0;color:white;font-size:20px;">Nieuwe cursusaanmelding</h2>
    <p style="margin:8px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">${centrum || ""} &middot; ${vandaag}</p>
  </div>

  <div style="padding:28px 32px;">
    <p style="color:#333;font-size:15px;margin-top:0;">${aanhef}</p>
    <p style="color:#555;font-size:14px;">Er heeft zich een nieuwe cursist aangemeld en betaald:</p>

    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0;">
      <tr style="background:#f8f9fa;">
        <td style="padding:10px 12px;color:#888;width:38%;">Naam</td>
        <td style="padding:10px 12px;color:#333;font-weight:600;">${cursistNaam}</td>
      </tr>
      <tr>
        <td style="padding:10px 12px;color:#888;border-top:1px solid #eee;">E-mail</td>
        <td style="padding:10px 12px;border-top:1px solid #eee;">
          <a href="mailto:${cursistEmail}" style="color:#1a3a5c;">${cursistEmail}</a>
        </td>
      </tr>
      ${rij("Telefoon",   cursistTelefoon, true)}
      ${rij("Startdatum", initiatieDatum ? formatDatum(initiatieDatum) : "", false)}
      ${rij("Tijden",     tijdslot,  true)}
      ${rij("Locatie",    locatie,   false)}
      ${bedragIncl ? `
      <tr style="background:#f8f9fa;">
        <td style="padding:10px 12px;color:#888;border-top:1px solid #eee;">Betaald</td>
        <td style="padding:10px 12px;border-top:1px solid #eee;color:#27ae60;font-weight:700;">
          ${formatBedrag(bedragIncl)}
          <span style="color:#888;font-weight:400;font-size:12px;">(${methode || "Mollie"})</span>
        </td>
      </tr>` : ""}
    </table>

    <p style="color:#888;font-size:12px;margin-top:24px;padding-top:16px;border-top:1px solid #eee;text-align:center;">
      Automatisch bericht van TM Nederland
    </p>
  </div>

</div>
</body></html>`;

      await sendMail({
        to:      leraarEmail,
        subject: `Nieuwe aanmelding: ${cursistNaam} — ${centrum || ""}`,
        html,
      });
      console.log(`✓ Leraar notificatie verstuurd naar: ${leraarEmail}`);
    }

    // ── Mollie: betaling aanmaken ──────────────────────
    app.post("/mollie/betaling/create", jsonParser, async (req, res) => {
      try {
        const {
          methode, voornaam, achternaam, email, telefoon,
          straat, huisnummer, postcode, stad,
          bedrag, cursusnaam, hubspot_contact_id, centrum, tarief,
          cursusdatum, plaats,
          extraData = {},
        } = req.body;

        if (!["ideal", "creditcard", "in3"].includes(methode)) {
          return res.status(400).json({ error: "Ongeldige betaalmethode." });
        }
        if (!voornaam || !achternaam || !email || !bedrag) {
          return res.status(400).json({ error: "Vul alle verplichte velden in." });
        }

        let checkoutUrl;

        if (methode === "in3") {
          const totaal = parseFloat(bedrag);
          const btw    = +(totaal - totaal / 1.21).toFixed(2);

          // Convert Dutch phone number to E.164 format
          const toE164 = (num) => {
            if (!num) return null;
            const cleaned = num.replace(/[\s\-().]/g, "");
            if (cleaned.startsWith("+")) return cleaned;
            if (cleaned.startsWith("00")) return "+" + cleaned.slice(2);
            if (cleaned.startsWith("0")) return "+31" + cleaned.slice(1);
            return null;
          };
          const phoneE164 = toE164(telefoon);

          const order  = await mollie.orders.create({
            orderNumber: `TM-${Date.now()}`,
            locale:      "nl_NL",
            method:      "in3",
            amount:      { currency: "EUR", value: totaal.toFixed(2) },
            redirectUrl: `${process.env.SITE_URL}/bedankt`,
            webhookUrl:  `${process.env.RAILWAY_URL}/mollie/webhook`,
            billingAddress: {
              givenName:       voornaam.trim(),
              familyName:      achternaam.trim(),
              email:           email.trim(),
              ...(phoneE164 && { phone: phoneE164 }),
              streetAndNumber: `${straat.trim()} ${huisnummer.trim()}`,
              postalCode:      postcode.trim(),
              city:            stad.trim(),
              country:         "NL",
            },
            lines: [{
              name:        cursusnaam || "TM Cursus",
              quantity:    1,
              unitPrice:   { currency: "EUR", value: totaal.toFixed(2) },
              totalAmount: { currency: "EUR", value: totaal.toFixed(2) },
              vatRate:     "21.00",
              vatAmount:   { currency: "EUR", value: btw.toFixed(2) },
            }],
            metadata: {
              type: "in3_order", hubspot_contact_id, centrum, cursusnaam, tarief,
              naam: `${voornaam} ${achternaam}`, email,
              bedrag_incl: totaal.toFixed(2),
              bedrag_excl: (totaal / 1.21).toFixed(2),
              ...(cursusdatum && { cursusdatum }),
              ...(plaats && { plaats }),
              ...extraData,
            },
          });
          checkoutUrl = order._links.checkout.href;

        } else {
          const payment = await mollie.payments.create({
            amount:      { currency: "EUR", value: parseFloat(bedrag).toFixed(2) },
            description: cursusnaam || "TM Cursus",
            method:      methode === "creditcard" ? "creditcard" : "ideal",
            redirectUrl: `${process.env.SITE_URL}/bedankt`,
            webhookUrl:  `${process.env.RAILWAY_URL}/mollie/webhook`,
            metadata: {
              type: "payment", hubspot_contact_id, centrum, cursusnaam, tarief,
              naam: `${voornaam} ${achternaam}`, email,
              bedrag_incl: parseFloat(bedrag).toFixed(2),
              bedrag_excl: (parseFloat(bedrag) / 1.21).toFixed(2),
              ...(cursusdatum && { cursusdatum }),
              ...(plaats && { plaats }),
              ...extraData,
            },
          });
          checkoutUrl = payment._links.checkout.href;
        }

        res.json({ checkoutUrl });

      } catch (err) {
        console.error("Mollie create error:", err.message, err.stack);
        res.status(500).json({ error: "Betaling kon niet worden aangemaakt." });
      }
    });

    // ── Mollie: webhook ────────────────────────────────
    app.post("/mollie/webhook", express.urlencoded({ extended: false }), async (req, res) => {
      res.sendStatus(200);
      const { id } = req.body;
      if (!id) return;

      try {
        const VASTE_KEYS = new Set([
          "type", "hubspot_contact_id", "centrum", "cursusnaam", "tarief",
          "naam", "email", "bedrag_incl", "bedrag_excl",
        ]);

        let meta, naam, email, telefoon = "", methode, contactId, centrum;

        if (id.startsWith("ord_")) {
          const order = await mollie.orders.get(id);
          if (order.status !== "authorized" && order.status !== "paid") return;
          meta     = order.metadata || {};
          naam     = `${order.billingAddress.givenName} ${order.billingAddress.familyName}`;
          email    = order.billingAddress.email;
          telefoon = order.billingAddress.phone;
          methode  = "In3";
        } else {
          const payment = await mollie.payments.get(id);
          if (payment.status !== "paid") return;
          meta    = payment.metadata || {};
          naam    = meta.naam;
          email   = meta.email;
          methode = payment.method;
        }

        contactId = meta.hubspot_contact_id;
        centrum   = meta.centrum;
        const extraData = Object.fromEntries(
          Object.entries(meta).filter(([k]) => !VASTE_KEYS.has(k))
        );

        // ── HubSpot contact ophalen (voor leraar + cursusdata) ──
        // Fallback: zoek op e-mail als contactId ontbreekt (bijv. directe form-gebruikers)
        let hubContact = contactId
          ? await getHubSpotContact(contactId)
          : await getHubSpotContactByEmail(email);
        if (!hubContact && email) {
          hubContact = await getHubSpotContactByEmail(email);
        }
        if (hubContact && !contactId) {
          contactId = hubContact.id;
          console.log(`✓ contactId hersteld via e-mail: ${contactId}`);
        }
        // Geen bestaand contact gevonden: maak nieuw aan
        if (!hubContact && email) {
          const naamDelen = (naam || "").trim().split(/\s+/);
          const newContact = await createHubSpotContact({
            firstname:           naamDelen[0] || "",
            lastname:            naamDelen.slice(1).join(" ") || "",
            email,
            phone:               telefoon || "",
            centrum_boekhouding: centrum  || "",
          });
          if (newContact?.id) {
            contactId  = newContact.id;
            hubContact = { id: contactId, properties: {} };
            console.log(`✓ Nieuw HubSpot contact aangemaakt: ${email} → ${contactId}`);
          } else if (newContact?.error === "CONTACT_EXISTS") {
            // Contact bestaat maar was nog niet geïndexeerd voor e-mailzoekactie (race condition)
            const match = newContact.message?.match(/Existing ID:\s*(\d+)/);
            if (match) {
              contactId  = match[1];
              hubContact = await getHubSpotContact(contactId) || { id: contactId, properties: {} };
              console.log(`✓ Bestaand contact hersteld via CONTACT_EXISTS: ${email} → ${contactId}`);
            }
          }
        }
        const contact        = hubContact?.properties;
        const leraarEmail    = contact?.leraar_email      || "";
        const voornaamLeraar = contact?.voornaam_leraar   || "";
        const initiatieDatum = contact?.initiatie_datum   || "";
        const tijdslot       = contact?.cursus_tijdslot   || "";
        const locatie        = contact?.plaats_instructie || "";
        const taal           = contact?.taal_nlen         || "NL";
        const telefoonFinal  = contact?.phone             || telefoon;

        // ── HubSpot: contact updaten ────────────────────────────
        // initiatie_datum wordt NIET overschreven — staat al correct via het formulier
        await updateHubSpotContact(contactId, {
          cursusbedrag_betaald: parseFloat(meta.bedrag_incl),
          tm_status:            "Meditator",
        });

        // ── HubSpot: Soft Opt-in ────────────────────────────────
        await setSoftOptIn(email);

        // ── HubSpot: partner contact aanmaken ───────────────────
        const isPartner = meta.tarief?.includes("partner");
        if (isPartner && extraData.partner_email) {
          await createHubSpotContact({
            firstname:            extraData.partner_voornaam      || "",
            lastname:             extraData.partner_achternaam    || "",
            email:                extraData.partner_email,
            date_of_birth:        extraData.partner_geboortedatum || "",
            cursusbedrag_betaald: meta.bedrag_incl,
            initiatie_datum:      initiatieDatum,
            centrum_boekhouding:  centrum,
          });
          console.log(`✓ Partner contact aangemaakt: ${extraData.partner_email}`);
        }

        // ── Google Sheets ───────────────────────────────────────
        await syncToGoogleSheets({
          metadata: {
            cursus:     meta.cursusnaam,
            centrum,
            naam,
            email,
            telefoon:   telefoonFinal,
            bedragIncl: meta.bedrag_incl,
            bedragExcl: meta.bedrag_excl,
            methode,
            referentie: id,
            tarief:     meta.tarief || "",
            datum:      new Date().toLocaleDateString("nl-NL"),
            cursusdatum: initiatieDatum,
            plaats:      locatie,
            ...extraData,
          },
        });

        // ── Bevestigingsmail aan cursist ────────────────────────
        await stuurBevestigingCursist({
          naam,
          email,
          centrum,
          cursusnaam:    meta.cursusnaam,
          initiatieDatum,
          tijdslot,
          locatie,
          bedragIncl:    meta.bedrag_incl,
          methode,
          mollieId:      id,
          taal,
        });

        // ── Notificatie aan leraar ──────────────────────────────
        await stuurLeraarsNotificatie({
          leraarEmail: leraarEmail || "nationaal@transcendentemeditatie.com",
          voornaamLeraar,
          cursistNaam:     naam,
          cursistEmail:    email,
          cursistTelefoon: telefoonFinal,
          centrum,
          initiatieDatum,
          tijdslot,
          locatie,
          cursusnaam:      meta.cursusnaam,
          bedragIncl:      meta.bedrag_incl,
          methode,
        });

        console.log(`✓ Mollie ${id} (${methode}) volledig verwerkt`);

      } catch (err) {
        console.error("Mollie webhook fout:", err.message, err.stack);
      }
    });

    console.log("✓ Mollie routes geregistreerd");

  } catch (err) {
    console.error("⚠ Mollie initialisatie gefaald:", err.message);
  }
} else {
  console.warn("⚠ MOLLIE_API_KEY niet gevonden - Mollie routes uitgeschakeld");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server draait op poort ${PORT}`))
  .on("error", (err) => console.error("Listen error:", err));

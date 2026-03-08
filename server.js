// v2
process.on('uncaughtException', (err) => {
  console.error('CRASH:', err.message, err.stack);
});
require("dotenv").config();
const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { syncToGoogleSheets } = require("./google-sheets");

const { createMollieClient } = require('@mollie/api-client');
const mollie = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });
const jsonParser = express.json();
const cors = require('cors');

const app = express();
app.use(cors());

// ── Status check ───────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

// ── Mollie: betaling aanmaken ──────────────────────────
app.post('/mollie/betaling/create', jsonParser, async (req, res) => {
  const {
    methode, voornaam, achternaam, email, telefoon,
    straat, huisnummer, postcode, stad,
    bedrag, cursusnaam, hubspot_contact_id, centrum,
    extraData = {},
  } = req.body;

  if (!['ideal', 'creditcard', 'in3'].includes(methode)) {
    return res.status(400).json({ error: 'Ongeldige betaalmethode.' });
  }
  if (!voornaam || !achternaam || !email || !bedrag) {
    return res.status(400).json({ error: 'Vul alle verplichte velden in.' });
  }

  try {
    let checkoutUrl;
    if (methode === 'in3') {
      const totaal = parseFloat(bedrag);
      const btw    = +(totaal - totaal / 1.21).toFixed(2);
      const order  = await mollie.orders.create({
        orderNumber: `TM-${Date.now()}`,
        locale:      'nl_NL',
        method:      'in3',
        amount:      { currency: 'EUR', value: totaal.toFixed(2) },
        redirectUrl: `${process.env.SITE_URL}/bedankt`,
        webhookUrl:  `${process.env.RAILWAY_URL}/mollie/webhook`,
        billingAddress: {
          givenName: voornaam.trim(), familyName: achternaam.trim(),
          email: email.trim(), phone: telefoon.trim(),
          streetAndNumber: `${straat.trim()} ${huisnummer.trim()}`,
          postalCode: postcode.trim(), city: stad.trim(), country: 'NL',
        },
        lines: [{
          name: cursusnaam || 'TM Cursus', quantity: 1,
          unitPrice:   { currency: 'EUR', value: totaal.toFixed(2) },
          totalAmount: { currency: 'EUR', value: totaal.toFixed(2) },
          vatRate: '21.00', vatAmount: { currency: 'EUR', value: btw.toFixed(2) },
        }],
        metadata: {
          type: 'in3_order', hubspot_contact_id, centrum, cursusnaam,
          naam: `${voornaam} ${achternaam}`, email,
          bedrag_incl: totaal.toFixed(2),
          bedrag_excl: (totaal / 1.21).toFixed(2),
          ...extraData,
        },
      });
      checkoutUrl = order._links.checkout.href;
    } else {
      const payment = await mollie.payments.create({
        amount:      { currency: 'EUR', value: parseFloat(bedrag).toFixed(2) },
        description: cursusnaam || 'TM Cursus',
        method:      methode === 'creditcard' ? 'creditcard' : 'ideal',
        redirectUrl: `${process.env.SITE_URL}/bedankt`,
        webhookUrl:  `${process.env.RAILWAY_URL}/mollie/webhook`,
        metadata: {
          type: 'payment', hubspot_contact_id, centrum, cursusnaam,
          naam: `${voornaam} ${achternaam}`, email,
          bedrag_incl: parseFloat(bedrag).toFixed(2),
          bedrag_excl: (parseFloat(bedrag) / 1.21).toFixed(2),
          ...extraData,
        },
      });
      checkoutUrl = payment._links.checkout.href;
    }
    res.json({ checkoutUrl });
  } catch (err) {
    console.error('Mollie create error:', err);
    res.status(500).json({ error: 'Betaling kon niet worden aangemaakt.' });
  }
});

// ── Mollie: webhook ────────────────────────────────────
app.post('/mollie/webhook', jsonParser, async (req, res) => {
  res.sendStatus(200);
  const { id } = req.body;
  if (!id) return;

  try {
    const VASTE_KEYS = new Set([
      'type','hubspot_contact_id','centrum','cursusnaam',
      'naam','email','bedrag_incl','bedrag_excl',
    ]);

    let meta, naam, email, telefoon = '', methode, contactId, centrum;

    if (id.startsWith('ord_')) {
      const order = await mollie.orders.get(id);
      if (order.status !== 'authorized' && order.status !== 'paid') return;
      meta     = order.metadata || {};
      naam     = `${order.billingAddress.givenName} ${order.billingAddress.familyName}`;
      email    = order.billingAddress.email;
      telefoon = order.billingAddress.phone;
      methode  = 'In3';
    } else {
      const payment = await mollie.payments.get(id);
      if (payment.status !== 'paid') return;
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

    // HubSpot updaten
    if (contactId) {
      await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
        method:  'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ properties: {
          cursusbedrag_betaald: meta.bedrag_incl,
          initiatie_datum:      new Date().toISOString().split('T')[0],
          betaalmethode:        methode,
          centrum_boekhouding:  centrum,
        }}),
      });
    }

    // Google Sheets
    await fetch(process.env.SHEETS_WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        datum: new Date().toLocaleDateString('nl-NL'),
        naam, email, telefoon,
        cursus: meta.cursusnaam, centrum,
        bedragIncl: meta.bedrag_incl,
        bedragExcl: meta.bedrag_excl,
        methode, referentie: id,
        ...extraData,
      }),
    });

    console.log(`✓ Mollie ${id} (${methode}) verwerkt`);
  } catch (err) {
    console.error('Mollie webhook fout:', err);
  }
});

// ── Stripe: webhook ────────────────────────────────────
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`Received event type: ${event.type}`);

  if (event.type === "checkout.session.completed") {
    console.log(`Processing checkout session: ${event.data.object.id}`);
    const session = event.data.object;

    const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);

    const customFields = {};
    if (session.custom_fields) {
      session.custom_fields.forEach(field => {
        if (field.dropdown?.value) {
          customFields[field.key] = field.dropdown.options.find(opt => opt.value === field.dropdown.value)?.label || field.dropdown.value;
        } else if (field.text?.value) {
          customFields[field.key] = field.text.value;
        }
      });
    }

    paymentIntent.metadata = {
      ...paymentIntent.metadata,
      ...session.metadata,
      ...customFields,
      email: session.customer_details?.email || paymentIntent.metadata?.email,
      name:  session.customer_details?.name  || paymentIntent.metadata?.name,
    };

    await syncToGoogleSheets(paymentIntent);
    console.log(`Payment processed successfully`);
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server draait op poort ${PORT}`))
  .on('error', (err) => console.error('Listen error:', err));

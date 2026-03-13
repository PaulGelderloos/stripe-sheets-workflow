// v4 - Robuuste error handling voor Mollie + Stripe
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message, err.stack);
  // Server blijft draaien!
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err.message, err.stack);
  // Server blijft draaien!
});

require("dotenv").config();
const express = require("express");
const cors = require('cors');

const app = express();
app.use(cors());

// ── Status check ───────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

// ── Stripe setup (alleen als keys aanwezig) ────────────
let stripe, syncToGoogleSheets;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  syncToGoogleSheets = require("./google-sheets").syncToGoogleSheets;
  
  app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const sig = req.headers["stripe-signature"];
      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );

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
    } catch (err) {
      console.error("Stripe webhook error:", err.message, err.stack);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  });
} else {
  console.warn('⚠ STRIPE_SECRET_KEY niet gevonden - Stripe webhooks uitgeschakeld');
}

// ── Mollie setup (alleen als keys aanwezig) ────────────
let mollie;
if (process.env.MOLLIE_API_KEY) {
  try {
    const { createMollieClient } = require('@mollie/api-client');
    mollie = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });
    
    const jsonParser = express.json();

    // ── HubSpot helpers ────────────────────────────────
    async function updateHubSpotContact(contactId, properties) {
      if (!contactId || !process.env.HUBSPOT_PRIVATE_APP_TOKEN) return;
      try {
        await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
          method:  'PATCH',
          headers: {
            'Authorization': `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({ properties }),
        });
      } catch (err) {
        console.error('HubSpot update error:', err.message);
      }
    }

    async function createHubSpotContact(properties) {
      if (!process.env.HUBSPOT_PRIVATE_APP_TOKEN) return null;
      try {
        const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({ properties }),
        });
        const data = await res.json();
        if (!res.ok) console.error('HubSpot contact aanmaken mislukt:', data);
        return data;
      } catch (err) {
        console.error('HubSpot create error:', err.message);
        return null;
      }
    }

    // ── Mollie: betaling aanmaken ──────────────────────
    app.post('/mollie/betaling/create', jsonParser, async (req, res) => {
      try {
        const {
          methode, voornaam, achternaam, email, telefoon,
          straat, huisnummer, postcode, stad,
          bedrag, cursusnaam, hubspot_contact_id, centrum, tarief,
          extraData = {},
        } = req.body;

        if (!['ideal', 'creditcard', 'in3'].includes(methode)) {
          return res.status(400).json({ error: 'Ongeldige betaalmethode.' });
        }
        if (!voornaam || !achternaam || !email || !bedrag) {
          return res.status(400).json({ error: 'Vul alle verplichte velden in.' });
        }

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
              email: email.trim(), phone: telefoon?.trim() || '+31000000000',
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
              type: 'in3_order', hubspot_contact_id, centrum, cursusnaam, tarief,
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
              type: 'payment', hubspot_contact_id, centrum, cursusnaam, tarief,
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
        console.error('Mollie create error:', err.message, err.stack);
        res.status(500).json({ error: 'Betaling kon niet worden aangemaakt.' });
      }
    });

    // ── Mollie: webhook ────────────────────────────────
    app.post('/mollie/webhook', jsonParser, async (req, res) => {
      res.sendStatus(200);
      const { id } = req.body;
      if (!id) return;

      try {
        if (!syncToGoogleSheets) {
          console.error('syncToGoogleSheets niet beschikbaar');
          return;
        }

        const VASTE_KEYS = new Set([
          'type','hubspot_contact_id','centrum','cursusnaam','tarief',
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

        // ── HubSpot: hoofdcontact updaten ──────────────
        await updateHubSpotContact(contactId, {
          cursusbedrag_betaald:       meta.bedrag_incl,
          initiatie_datum:            new Date().toISOString().split('T')[0],
          betaalmethode:              methode,
          centrum_boekhouding:        centrum,
          tm_status:                  'Meditator',
          global_subscription_status: 'Soft Opt-In',
        });

        // ── HubSpot: partner contact aanmaken ──────────
        const isPartner = meta.tarief && meta.tarief.includes('partner');
        if (isPartner && extraData.partner_email) {
          await createHubSpotContact({
            firstname:     extraData.partner_voornaam       || '',
            lastname:      extraData.partner_achternaam     || '',
            email:         extraData.partner_email,
            date_of_birth: extraData.partner_geboortedatum  || '',
            cursusbedrag_betaald: meta.bedrag_incl,
            initiatie_datum:      new Date().toISOString().split('T')[0],
            centrum_boekhouding:  centrum,
          });
          console.log(`✓ Partner contact aangemaakt: ${extraData.partner_email}`);
        }

        // ── Google Sheets ──────────────────────────────
        await syncToGoogleSheets({
          metadata: {
            cursus:     meta.cursusnaam,
            centrum,
            naam,
            email,
            telefoon,
            bedragIncl: meta.bedrag_incl,
            bedragExcl: meta.bedrag_excl,
            methode,
            referentie: id,
            tarief:     meta.tarief || '',
            datum:      new Date().toLocaleDateString('nl-NL'),
            ...extraData,
          }
        });

        console.log(`✓ Mollie ${id} (${methode}) verwerkt`);
      } catch (err) {
        console.error('Mollie webhook fout:', err.message, err.stack);
      }
    });

    console.log('✓ Mollie routes geregistreerd');
  } catch (err) {
    console.error('⚠ Mollie initialisatie gefaald:', err.message);
  }
} else {
  console.warn('⚠ MOLLIE_API_KEY niet gevonden - Mollie routes uitgeschakeld');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server draait op poort ${PORT}`))
  .on('error', (err) => console.error('Listen error:', err));

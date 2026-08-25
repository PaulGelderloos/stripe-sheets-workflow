// v17 - BTW 21% breakdown in factuur
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
  res.json({ status: "ok", version: "v19" });
});

// ── Course feed proxy ──────────────────────────────────
// The booking page used to call Apps Script directly, which costs a few
// seconds of container start-up per visitor and occasionally minutes. This
// keeps a copy in memory, refreshed in the background, so a visitor never
// waits on Google. If Apps Script is slow or down, the last good copy is
// served instead of an empty list.
const CURSUS_FEED_UPSTREAM =
  "https://script.google.com/macros/s/AKfycbxbbvduAy1JdKsZlU0BDQDo0Hq53iMzKyP3Er2eHwo_liFhKdbyREkdDN0Rjp9oLq7P_g/exec";
const CURSUS_FEED_REFRESH_MS = 60 * 1000;
const CURSUS_FEED_TIMEOUT_MS = 25 * 1000;

const cursusFeed = {
  json: null,          // the bare JSON payload, without the JSONP wrapper
  count: 0,
  fetchedAt: 0,
  refreshing: null,    // in-flight promise, so concurrent callers share one fetch
  lastError: null,
  failures: 0,
};

// Upstream answers with `callback({...})`. Peel the wrapper so the payload can
// be re-wrapped with whatever callback name this caller asked for.
function stripJsonp(body) {
  const open = body.indexOf("(");
  const close = body.lastIndexOf(")");
  if (open === -1 || close === -1 || close < open) return null;
  return body.slice(open + 1, close);
}

async function haalCursusFeed() {
  if (cursusFeed.refreshing) return cursusFeed.refreshing;

  cursusFeed.refreshing = (async () => {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), CURSUS_FEED_TIMEOUT_MS);
    try {
      const res = await fetch(CURSUS_FEED_UPSTREAM + "?callback=cb", {
        redirect: "follow",
        signal: stop.signal,
      });
      if (!res.ok) throw new Error(`upstream ${res.status}`);

      const json = stripJsonp(await res.text());
      if (!json) throw new Error("geen JSONP-antwoord");

      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed.cursussen)) throw new Error("veld cursussen ontbreekt");

      // Apps Script answers its own failures with an empty list plus an error
      // field. Never let that overwrite a good copy.
      if (parsed.error) throw new Error(`upstream meldt: ${parsed.error}`);
      if (parsed.cursussen.length === 0 && cursusFeed.count > 0) {
        throw new Error("lege lijst terwijl er eerder cursussen waren");
      }

      cursusFeed.json = json;
      cursusFeed.count = parsed.cursussen.length;
      cursusFeed.fetchedAt = Date.now();
      cursusFeed.lastError = null;
      cursusFeed.failures = 0;
      return json;
    } catch (err) {
      cursusFeed.lastError = err.message;
      cursusFeed.failures++;
      console.warn(`Cursusfeed ophalen mislukt (${cursusFeed.failures}x): ${err.message}`);
      return null;
    } finally {
      clearTimeout(timer);
      cursusFeed.refreshing = null;
    }
  })();

  return cursusFeed.refreshing;
}

app.get("/cursussen", async (req, res) => {
  const callback = String(req.query.callback || "callback").replace(/[^\w$.]/g, "");

  // Only the very first visitor after a restart waits; everyone else is served
  // from memory while the refresh happens behind them.
  if (!cursusFeed.json) await haalCursusFeed();

  const payload = cursusFeed.json || JSON.stringify({ cursussen: [], error: cursusFeed.lastError });

  res.type("application/javascript");
  res.set("Cache-Control", "public, max-age=30");
  res.send(`${callback}(${payload})`);
});

app.get("/cursussen/status", (req, res) => {
  res.json({
    cursussen: cursusFeed.count,
    ouderdomSeconden: cursusFeed.fetchedAt ? Math.round((Date.now() - cursusFeed.fetchedAt) / 1000) : null,
    laatsteFout: cursusFeed.lastError,
    mislukt: cursusFeed.failures,
  });
});

// Called after a booking takes the last seat, so the list does not keep showing
// places that are gone.
app.get("/cursussen/ververs", async (req, res) => {
  await haalCursusFeed();
  res.json({ cursussen: cursusFeed.count, laatsteFout: cursusFeed.lastError });
});

haalCursusFeed();
setInterval(haalCursusFeed, CURSUS_FEED_REFRESH_MS);

// ── Short teacher links ────────────────────────────────
// One stable link per teacher. The real destination lives here, so changing it
// never means asking every teacher to replace a link they saved months ago in
// WhatsApp.
//
// The redirect points at the course booking page filtered to that teacher, not
// at the booking form itself. A bare form link leaves centre, instruction date
// and time slot empty — the booking page fills them in.
const TEACHER_LINKS = {
  // The address is the one the booking page filters on, which is the address in
  // the course configuration sheet — not always the one a teacher uses for mail.
  // `courses: false` means no courses are filed under them: filtering would show
  // an empty list, so those links land on the full booking page instead.
  "almar":       { email: "eindhoven.tm@gmail.com", courses: true  },
  "ben":         { email: "oldenzaal@tm.nl",        courses: true  },
  // Both names, because both teach. The single-name forms stay valid so links
  // already shared keep working.
  "charles":      { email: "charles.jung@tm.org",   courses: true  },
  "charles-elsa": { email: "charles.jung@tm.org",   courses: true  },
  "conny":       { email: "postelc@outlook.com",    courses: false },
  "elles":       { email: "utrecht-stad@tm.nl",     courses: true  },
  "gerda":       { email: "utrecht@tm.nl",          courses: false },
  "gerrie":      { email: "geluca@hccnet.nl",       courses: true  },
  "jos":         { email: "josidhats@gmail.com",    courses: true  },
  "josine":      { email: "josine.maenen@tm.nl",    courses: true  },
  "mariya":      { email: "mariya.grylyuk@tm.org",  courses: true, lang: "en" },
  "paul":        { email: "paul@gelderloos.com",    courses: true  },
  "ria":         { email: "tmwaalwijk@planet.nl",   courses: true  },
  "rien":        { email: "riencalis@hotmail.com",  courses: false },
  "sjoerd":      { email: "iwcvos@gmail.com",       courses: true  },
  "ton":          { email: "jans-jong@planet.nl",   courses: true  },
  "ton-gerda":    { email: "jans-jong@planet.nl",   courses: true  },
  "wim-marike":  { email: "soma@xs4all.nl",         courses: true  },
};


const TEACHER_REFERRAL_CODE = "CRM4201";        // channel: Local Centre Promotion
const TM_SITE = "https://www.tm.nl";

function redirectTeacherLink(req, res) {
  let slug = String(req.params.slug || "").toLowerCase();

  // "paul-en" / "paul-nl" pick the language, but only when the part before the
  // suffix is a real name — a teacher whose own slug ends in -en still works.
  let suffixLang = "";
  if (!TEACHER_LINKS[slug]) {
    const match = /^(.+)-(en|nl)$/.exec(slug);
    if (match && TEACHER_LINKS[match[1]]) {
      slug = match[1];
      suffixLang = match[2];
    }
  }
  const teacher = TEACHER_LINKS[slug];

  // An unknown name still reaches the booking page rather than an error — the
  // visitor came to book a course, not to debug a link.
  if (slug && !teacher) console.warn(`Onbekende leraar-slug: ${slug}`);

  // Explicit ?lang= wins, then the suffix, then the teacher's own default.
  const asked = String(req.query.lang || "").toLowerCase() || suffixLang ||
                (teacher && teacher.lang) || "nl";
  const lang = asked === "en" ? "en" : "nl";
  const url  = new URL(`${TM_SITE}/${lang}/cursus-boeken`);

  // Carry through anything appended to the short link (?stad=, ?cursus_type=),
  // skipping the two this route sets itself.
  for (const [key, value] of Object.entries(req.query)) {
    if (key === "lang" || key === "leraar_email") continue;
    if (typeof value === "string") url.searchParams.set(key, value);
  }
  // Only filter when there is something to filter to.
  if (teacher && teacher.courses) url.searchParams.set("leraar_email", teacher.email);

  // A visitor who arrived here from an ad keeps that campaign code; the
  // referral code is only the fallback for a link shared hand to hand.
  if (!url.searchParams.has("leadsource")) {
    url.searchParams.set("leadsource", TEACHER_REFERRAL_CODE);
  }

  res.redirect(302, url.toString());
}

// b.tm.nl/<name>. The bare /b/<name> form stays valid so any link already
// handed out keeps working; the short one is what teachers are given.
app.get("/b/:slug?", redirectTeacherLink);

// ── E-mail via Apps Script relay ───────────────────────
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycby4hh-ER7zi6E6NZtpSw7tA1vuIRnpGrbTFxaG-l3FduJ6YC2aoARiBlYNLprCOoIP2Tw/exec";

async function sendMail({ to, subject, html }) {
  // Apps Script antwoordt op elke POST met een 302 naar een
  // script.googleusercontent.com/.../echo-URL die alleen GET accepteert.
  // fetch's ingebouwde redirect:"follow" zet die POST niet betrouwbaar om
  // naar GET op Railway's Node/undici — vandaar handmatig afhandelen.
  let res = await fetch(APPS_SCRIPT_URL, {
    method:   "POST",
    headers:  { "Content-Type": "application/json" },
    body:     JSON.stringify({ action: "send_email", to, subject, html }),
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) throw new Error(`Apps Script e-mail fout: redirect zonder Location-header (${res.status})`);
    res = await fetch(location, { method: "GET" });
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Apps Script e-mail fout: ${res.status} ${text}`);
  console.log(`✓ E-mail verstuurd via Apps Script naar: ${to}`);
}

// ── Leraar lookup via plaats/centrum ───────────────────
const CENTRA_LERAREN = [
  { stad: "alkmaar",           email: "iwcvos@gmail.com",                          leraar: "Sjoerd" },
  { stad: "almere",            email: "soma@xs4all.nl",                            leraar: "Wim" },
  { stad: "amersfoort",        email: "jans-jong@planet.nl",                       leraar: "Ton" },
  { stad: "amsterdam",         email: "paul@gelderloos.com",                       leraar: "Paul" },
  { stad: "gaffelaarspad",     email: "paul@gelderloos.com",                       leraar: "Paul" },
  { stad: "apeldoorn",         email: "iwcvos@gmail.com",                          leraar: "Sjoerd" },
  { stad: "arnhem",            email: "charles.jung@tm.org",                       leraar: "Charles" },
  { stad: "boxtel",            email: "riaholt@planet.nl",                         leraar: "Ab" },
  { stad: "breda",             email: "iwcvos@gmail.com",                          leraar: "Sjoerd" },
  { stad: "den haag",          email: "mgrylyuk@gmail.com",                        leraar: "Mariya" },
  { stad: "eindhoven",         email: "Jacques.huyghe@gusp.org",                   leraar: "Jacques" },
  { stad: "emmen",             email: "iwcvos@gmail.com",                          leraar: "Sjoerd" },
  { stad: "enschede",          email: "ben.robijns@icloud.com",                    leraar: "Ben" },
  { stad: "groningen",         email: "iwcvos@gmail.com",                          leraar: "Sjoerd" },
  { stad: "heerlen",           email: "josidhats@gmail.com",                       leraar: "Jos" },
  { stad: "hengelo",           email: "ben.robijns@icloud.com",                    leraar: "Ben" },
  { stad: "hilversum",         email: "theo@xs.nl",                                leraar: "Theo" },
  { stad: "het gooi",          email: "theo@xs.nl",                                leraar: "Theo" },
  { stad: "hertogenbosch",     email: "riaholt@planet.nl",                         leraar: "Ria" },
  { stad: "den bosch",         email: "riaholt@planet.nl",                         leraar: "Ria" },
  { stad: "leeuwarden",        email: "iwcvos@gmail.com",                          leraar: "Sjoerd" },
  { stad: "lelystad",          email: "tm@lelystad.nl",                            leraar: "Marike" },
  { stad: "maastricht",        email: "j.maenen@hetnet.nl",                        leraar: "Josine" },
  { stad: "valkenburg",        email: "j.maenen@hetnet.nl",                        leraar: "Josine" },
  { stad: "vlodrop",           email: "conny.postel@maharishi.net",                leraar: "Conny" },
  { stad: "meru",              email: "conny.postel@maharishi.net",                leraar: "Conny" },
  { stad: "nijmegen",          email: "charles.jung@tm.org",                       leraar: "Charles" },
  { stad: "roermond",          email: "charles.jung@tm.org",                       leraar: "Charles" },
  { stad: "odili",             email: "charles.jung@tm.org",                       leraar: "Charles" },
  { stad: "rotterdam",         email: "geluca@hccnet.nl",                          leraar: "Gerrie" },
  { stad: "schiedam",          email: "geluca@hccnet.nl",                          leraar: "Gerrie" },
  { stad: "tilburg",           email: "riaholt@planet.nl",                         leraar: "Ria" },
  { stad: "utrecht",           email: "jans-jong@planet.nl",                       leraar: "Gerda" },
  { stad: "waalwijk",          email: "riaholt@planet.nl",                         leraar: "Ria" },
  { stad: "wageningen",        email: "e.ruchtie@chello.nl",                       leraar: "Erno" },
  { stad: "wassenaar",         email: "riencalis@hotmail.com",                     leraar: "Rien" },
  { stad: "zeeland",           email: "iwcvos@gmail.com",                          leraar: "Sjoerd" },
  { stad: "krabbendijke",      email: "iwcvos@gmail.com",                          leraar: "Sjoerd" },
  { stad: "zevenbergen",       email: "iwcvos@gmail.com",                          leraar: "Sjoerd" },
  { stad: "west-brabant",      email: "iwcvos@gmail.com",                          leraar: "Sjoerd" },
  { stad: "zwolle",            email: "iwcvos@gmail.com",                          leraar: "Sjoerd" },
];

function zoekLeraar(plaatsInstructie, centrum) {
  const tekst = (plaatsInstructie || centrum || "").toLowerCase();
  if (!tekst) return { email: "", leraar: "" };
  for (const c of CENTRA_LERAREN) {
    if (tekst.includes(c.stad)) return { email: c.email, leraar: c.leraar };
  }
  return { email: "", leraar: "" };
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
        bedrijfsnaam,
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
      ${bedrijfsnaam ? `<p style="margin:0 0 12px;color:#555;font-size:13px;">${isEN ? "Billed to" : "Factuuradres"}: <strong>${bedrijfsnaam}</strong></p>` : ""}
      <table style="width:100%;font-size:14px;">
        <tr>
          <td style="color:#555;padding:4px 0;">${cursusnaam || (isEN ? "TM Course" : "TM Cursus")} (${isEN ? "excl. VAT" : "excl. BTW"})</td>
          <td style="color:#333;text-align:right;">${formatBedrag(parseFloat(bedragIncl) / 1.21)}</td>
        </tr>
        <tr>
          <td style="color:#555;padding:4px 0;">${isEN ? "VAT (21%)" : "BTW (21%)"}</td>
          <td style="color:#333;text-align:right;">${formatBedrag(parseFloat(bedragIncl) - parseFloat(bedragIncl) / 1.21)}</td>
        </tr>
        <tr>
          <td style="color:#333;padding-top:8px;border-top:1px solid #ddd;font-weight:600;">${isEN ? "Total incl. VAT" : "Totaal incl. BTW"}</td>
          <td style="color:#333;text-align:right;font-weight:600;padding-top:8px;border-top:1px solid #ddd;">${formatBedrag(bedragIncl)}</td>
        </tr>
      </table>
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid #ddd;font-size:11px;color:#999;line-height:1.6;">
        Stichting Maharishi Vedisch Instituut<br>
        Gaffelaarspad 28, 1081 KK Amsterdam<br>
        Tel: 020 785 0048<br>
        KVK: 41160316 &middot; BTW: NL806088928B01<br>
        IBAN: NL98 INGB 0660 8746 79
      </div>
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
        partnerNaam, partnerEmail,
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
      ${partnerNaam ? `
      <tr>
        <td style="padding:10px 12px;color:#888;border-top:1px solid #eee;">Partner</td>
        <td style="padding:10px 12px;color:#333;border-top:1px solid #eee;">
          ${partnerNaam}${partnerEmail ? ` &middot; <a href="mailto:${partnerEmail}" style="color:#1a3a5c;">${partnerEmail}</a>` : ""}
        </td>
      </tr>` : ""}
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
            const match = newContact.message?.match(/Existing ID:\s*(\d+)/);
            if (match) {
              contactId  = match[1];
              hubContact = await getHubSpotContact(contactId) || { id: contactId, properties: {} };
              console.log(`✓ Bestaand contact hersteld via CONTACT_EXISTS: ${email} → ${contactId}`);
            }
          }
        }
        const contact        = hubContact?.properties;
        const initiatieDatum = contact?.initiatie_datum   || "";
        const tijdslot       = contact?.cursus_tijdslot   || "";
        const locatie        = contact?.plaats_instructie || "";
        const taal           = contact?.taal_nlen         || "NL";
        const telefoonFinal  = contact?.phone             || telefoon;

        // Leraar lookup: eerst HubSpot property, dan via plaats/centrum
        let leraarEmail    = contact?.leraar_email    || "";
        let voornaamLeraar = contact?.voornaam_leraar || "";
        if (!leraarEmail) {
          const match = zoekLeraar(locatie, centrum);
          leraarEmail    = match.email;
          voornaamLeraar = voornaamLeraar || match.leraar;
          if (match.email) console.log(`✓ Leraar gevonden via plaats lookup: ${locatie || centrum} → ${match.email}`);
        }

        // ── HubSpot: contact updaten ────────────────────────────
        // Bij een koppelaanmelding is bedrag_incl de gezamenlijke betaling
        // (1,5× het tarief) — per contact wordt de helft geboekt, anders
        // telt het maandrapport (SUMIF op cursusbedrag_betaald) dit dubbel.
        const bedragPerPersoon = extraData.partner_email
          ? parseFloat(meta.bedrag_incl) / 2
          : parseFloat(meta.bedrag_incl);

        await updateHubSpotContact(contactId, {
          cursusbedrag_betaald: bedragPerPersoon,
          tm_status:            "Meditator",
        });

        // ── HubSpot: Soft Opt-in ────────────────────────────────
        await setSoftOptIn(email);

        // ── HubSpot: partner contact aanmaken/bijwerken ─────────
        if (extraData.partner_email) {
          const partnerProps = {
            firstname:            extraData.partner_voornaam      || "",
            lastname:             extraData.partner_achternaam    || "",
            email:                extraData.partner_email,
            phone:                extraData.partner_telefoon      || "",
            date_of_birth:        extraData.partner_geboortedatum || "",
            cursusbedrag_betaald: bedragPerPersoon,
            initiatie_datum:      initiatieDatum,
            centrum_boekhouding:  centrum,
            tm_status:            "Meditator",
          };
          const bestaandPartnerContact = await getHubSpotContactByEmail(extraData.partner_email);
          if (bestaandPartnerContact) {
            await updateHubSpotContact(bestaandPartnerContact.id, partnerProps);
            console.log(`✓ Partner contact bijgewerkt: ${extraData.partner_email}`);
          } else {
            const newPartnerContact = await createHubSpotContact(partnerProps);
            if (newPartnerContact?.id) {
              console.log(`✓ Partner contact aangemaakt: ${extraData.partner_email}`);
            } else if (newPartnerContact?.error === "CONTACT_EXISTS" || newPartnerContact?.category === "CONFLICT") {
              const match = newPartnerContact.message?.match(/Existing ID:\s*(\d+)/);
              if (match) {
                await updateHubSpotContact(match[1], partnerProps);
                console.log(`✓ Partner contact hersteld via CONTACT_EXISTS en bijgewerkt: ${extraData.partner_email}`);
              } else {
                console.error("Partner contact: CONTACT_EXISTS zonder herleidbaar ID", newPartnerContact);
              }
            } else {
              console.error("Partner contact aanmaken mislukt:", newPartnerContact);
            }
          }
          await setSoftOptIn(extraData.partner_email);
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
          bedrijfsnaam:  extraData.bedrijfsnaam || "",
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
          partnerNaam:     extraData.partner_voornaam && extraData.partner_achternaam
                              ? `${extraData.partner_voornaam} ${extraData.partner_achternaam}` : "",
          partnerEmail:    extraData.partner_email || "",
        });

        // ── Vangnet: cursusdetails ontbreken ondanks betaling ───
        // Gebeurt vooral wanneer een leraar zijn kale BoekURL (alleen
        // ?leraar_email=&voornaam_leraar=) rechtstreeks deelt i.p.v. de
        // boekpagina, waardoor de hidden fields plaats/datum/tijdslot
        // nooit geprefilled worden.
        if (!locatie || !initiatieDatum) {
          try {
            await sendMail({
              to:      "paul@gelderloos.com",
              subject: `⚠ Cursusdetails ontbreken: ${naam} (${centrum || "centrum onbekend"})`,
              html: `<p>Betaling van <strong>${naam}</strong> (${email}) is verwerkt, maar `
                  + `${!locatie ? "plaats_instructie" : ""}${!locatie && !initiatieDatum ? " en " : ""}${!initiatieDatum ? "initiatie_datum" : ""} `
                  + `ontbreekt op het HubSpot-contact.</p>`
                  + `<p>Leraar: ${voornaamLeraar || "-"} (${leraarEmail || "onbekend"})<br>`
                  + `Centrum: ${centrum || "-"}<br>`
                  + `Contact: <a href="https://app-eu1.hubspot.com/contacts/147653339/record/0-1/${contactId}">${contactId}</a></p>`
                  + `<p style="color:#888;font-size:12px;">Waarschijnlijke oorzaak: leraar deelde de kale BoekURL rechtstreeks i.p.v. de boekpagina.</p>`,
            });
            console.log(`⚠ Vangnetmail verstuurd: ontbrekende cursusdetails voor ${email}`);
          } catch (mailErr) {
            console.error("Vangnetmail mislukt:", mailErr.message);
          }
        }

        console.log(`✓ Mollie ${id} (${methode}) volledig verwerkt`);

     } catch (err) {
  if (err.message && err.message.includes("different website profile")) {
    console.warn(`⚠ Mollie ${id} overgeslagen: behoort tot oud profiel`);
    return;
  }
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

// Registered last, after every real endpoint, so it can only catch what nothing
// else claimed. The pattern keeps it to bare names: no slashes, no dots, so a
// mistyped API path still 404s instead of silently redirecting.
app.get("/:slug([a-z0-9-]{2,30})", redirectTeacherLink);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server draait op poort ${PORT}`))
  .on("error", (err) => console.error("Listen error:", err));

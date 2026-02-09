require("dotenv").config();
const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { syncToGoogleSheets } = require("./google-sheets");

const app = express();
app.use(express.raw({ type: "application/json" }));
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});
app.post("/webhook", async (req, res) => {
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
  
  // Haal de payment intent op
  const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
  
  // Haal custom fields uit de session
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
  
  // Voeg metadata van de session toe aan de payment intent
  paymentIntent.metadata = {
    ...paymentIntent.metadata,
    ...session.metadata,
    ...customFields,
    email: session.customer_details?.email || paymentIntent.metadata?.email,
    name: session.customer_details?.name || paymentIntent.metadata?.name,
  };
  
  await syncToGoogleSheets(paymentIntent);
  console.log(`Payment processed successfully`);
}
  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server draait op poort ${PORT}`));

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

  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object;
    await syncToGoogleSheets(paymentIntent);
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server draait op poort ${PORT}`));

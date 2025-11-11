// server.js
import express from "express";
import Stripe from "stripe";
import fetch from "node-fetch";

const app = express();

// === ENV (LIVE) ===
const STRIPE_KEY            = process.env.STRIPE_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const WHOP_API_KEY          = process.env.WHOP_API_KEY || "";
const WHOP_PRODUCT_ID       = process.env.WHOP_PRODUCT_ID || "";

if (!STRIPE_KEY || !STRIPE_WEBHOOK_SECRET || !WHOP_API_KEY || !WHOP_PRODUCT_ID) {
  console.error("Missing env vars. Set STRIPE_KEY, STRIPE_WEBHOOK_SECRET, WHOP_API_KEY, WHOP_PRODUCT_ID");
  process.exit(1);
}

const stripe = new Stripe(STRIPE_KEY);

// Log di ogni richiesta (diagnostica anti-404)
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// Healthcheck
app.get("/", (_req, res) => res.status(200).send("OK"));

// IMPORTANTISSIMO: niente express.json() PRIMA del webhook
app.post("/stripe-webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("[STRIPE] Signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Ack immediato per evitare timeout su Render free
  res.status(200).json({ received: true });

  // Lavoro in background
  setImmediate(async () => {
    try {
      const type = event.type;
      const obj  = event.data.object;
      console.log("[STRIPE] Event:", type);

      const email =
        obj.customer_email ||
        (obj.customer_details ? obj.customer_details.email : null) ||
        obj.receipt_email || null;

      const callWhop = async (url, payload) => {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${WHOP_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key":
              (payload.external_reference || `${Date.now()}-${Math.random()}`)
          },
          body: JSON.stringify(payload)
        });
        const text = await r.text();
        console.log("[WHOP][REQ]", url, payload);
        console.log("[WHOP][RES]", r.status, text);
        if (!r.ok) throw new Error(`WHOP ${r.status}: ${text}`);
        return text ? JSON.parse(text) : {};
      };

      if (type === "checkout.session.completed" ||
          type === "invoice.paid" ||
          type === "payment_intent.succeeded") {

        if (!email) {
          console.warn("[WH] Nessuna email nel payload. Event:", type);
          return;
        }

        const user = await callWhop(
          "https://api.whop.com/api/v1/users/get_or_create",
          { email }
        );

        const externalRef = obj.subscription || obj.id;

        await callWhop("https://api.whop.com/api/v1/access_passes", {
          user_id: user.id,
          product_id: WHOP_PRODUCT_ID,
          external_reference: externalRef
        });
      }

      if (type === "customer.subscription.deleted" ||
          type === "invoice.payment_failed") {

        const externalRef = obj.subscription || obj.id;

        await callWhop("https://api.whop.com/api/v1/access_passes/revoke", {
          external_reference: externalRef
        });
      }
    } catch (e) {
      console.error("[WEBHOOK BG ERROR]", e);
    }
  });
});

// Parser JSON per eventuali altre rotte (mettilo SOLO dopo il webhook)
app.use(express.json());

// 404 esplicito
app.use((req, res) => {
  console.warn("[404] Path non gestito:", req.method, req.url);
  res.status(404).send("Not Found");
});

// Start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Listening on", PORT));

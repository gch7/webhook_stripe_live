// server.js
import express from "express";
import Stripe from "stripe";
import fetch from "node-fetch";

const app = express();

// ====== ENV (LIVE) ======
const STRIPE_KEY            = process.env.STRIPE_KEY;            // sk_live_...
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET; // whsec_live_...
const WHOP_API_KEY          = process.env.WHOP_API_KEY;          // whop_live_...
const WHOP_PRODUCT_ID       = process.env.WHOP_PRODUCT_ID;       // prod_...

if (!STRIPE_KEY || !STRIPE_WEBHOOK_SECRET || !WHOP_API_KEY || !WHOP_PRODUCT_ID) {
  console.error("Missing env vars: STRIPE_KEY / STRIPE_WEBHOOK_SECRET / WHOP_API_KEY / WHOP_PRODUCT_ID");
  process.exit(1);
}

const stripe = new Stripe(STRIPE_KEY);

// ---- LOG di ogni richiesta per debug 404/route ----
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// Healthcheck
app.get("/", (_req, res) => res.status(200).send("OK"));

// >>> NON mettere express.json() prima del webhook <<<
// Route WEBHOOK: accetta solo POST su /stripe-webhook
app.post("/stripe-webhook",
  // raw body per verifica firma
  express.raw({ type: "application/json" }),
  (req, res) => {
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

    // Risposta immediata per evitare timeout
    res.status(200).json({ received: true });

    // Processamento in background
    setImmediate(async () => {
      try {
        const type = event.type;
        const obj  = event.data.object;
        console.log("[STRIPE] Event:", type);

        const email =
          obj.customer_email ||
          obj.customer_details?.email ||
          obj.receipt_email ||
          null;

        const callWhop = async (url, payload) => {
          const r = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${WHOP_API_KEY}`,
              "Content-Type": "application/json",
              "Idempotency-Key":
                payload.external_reference || `${Date.now()}-${Math.random()}`
            },
            body: JSON.stringify(payload)
          });
          const txt = await r.text();
          console.log("[WHOP][REQ]", url, payload);
          console.log("[WHOP][RES]", r.status, txt);
          if (!r.ok) throw new Error(`WHOP ${r.status}: ${txt}`);
          try { return JSON.parse(txt); } catch { return {}; }
        };

        if (type === "checkout.session.completed" ||
            type === "invoice.paid" ||
            type === "payment_intent.succeeded") {
          if (!email) return console.warn("[WH] Nessuna email nel payload");
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
  }
);

// Parser JSON per eventuali altre rotte (dopo il webhook)
app.use(express.json());

// 404 esplicito per capire che path sta colpendo Stripe
app.use((req, res) => {
  console.warn("[404] Path non gestito:", req.method, req.url);
  res.status(404).send("Not Found");
});

// Avvio
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on", PORT));

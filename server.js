// server.js
import express from "express";
import Stripe from "stripe";
import fetch from "node-fetch";

const app = express();

// ====== ENV (TUTTE LIVE) ======
const STRIPE_KEY            = process.env.STRIPE_KEY;            // sk_live_...
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET; // whsec_live_...
const WHOP_API_KEY          = process.env.WHOP_API_KEY;          // whop_live_...
const WHOP_PRODUCT_ID       = process.env.WHOP_PRODUCT_ID;       // prod_...

if (!STRIPE_KEY || !STRIPE_WEBHOOK_SECRET || !WHOP_API_KEY || !WHOP_PRODUCT_ID) {
  console.error("Missing required env vars. Check STRIPE_KEY, STRIPE_WEBHOOK_SECRET, WHOP_API_KEY, WHOP_PRODUCT_ID.");
  process.exit(1);
}

const stripe = new Stripe(STRIPE_KEY);

// Healthcheck (utile per UptimeRobot o verifiche da browser)
app.get("/", (req, res) => res.status(200).send("OK"));

// ATTENZIONE: niente express.json() PRIMA del webhook.
// Stripe richiede il RAW body per la verifica della firma.
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

  // 1) Rispondi SUBITO a Stripe per evitare timeout sul piano free di Render
  res.status(200).json({ received: true });

  // 2) Processa in background
  setImmediate(async () => {
    const type = event.type;
    const obj  = event.data.object;

    try {
      console.log("[STRIPE] Event:", type);

      // Email fallback per i vari eventi
      const email =
        obj.customer_email ||
        obj.customer_details?.email ||
        obj.receipt_email ||
        null;

      // helper per chiamare Whop con log estesi
      const callWhop = async (url, payload) => {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${WHOP_API_KEY}`,
            "Content-Type": "application/json",
            // evita duplicati se Stripe ritenta
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

      // Concessione accesso (checkout iniziale + rinnovi)
      if (type === "checkout.session.completed" || type === "invoice.paid" || type === "payment_intent.succeeded") {
        // Se è un one-time, arriva payment_intent.succeeded
        if (!email) {
          console.warn("[WH] Nessuna email nel payload per", type);
          return;
        }

        // 1) Crea/recupera utente su Whop
        const user = await callWhop(
          "https://api.whop.com/api/v1/users/get_or_create",
          { email }
        );

        // 2) Crea Access Pass sul prodotto Whop
        // external_reference stabile per subscription: usa sub.id se presente
        const externalRef = obj.subscription || obj.id;
        await callWhop("https://api.whop.com/api/v1/access_passes", {
          user_id: user.id,
          product_id: WHOP_PRODUCT_ID,
          external_reference: externalRef
        });
      }

      // Revoca (cancellazione/insoluto)
      if (type === "customer.subscription.deleted" || type === "invoice.payment_failed") {
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

// Se ti serve JSON per altre route, mettilo DOPO il webhook
app.use(express.json());

// Avvio (Render imposta PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on", PORT));

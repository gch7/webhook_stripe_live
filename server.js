import express from "express";
import Stripe from "stripe";
import fetch from "node-fetch";

const app = express();

// === CONFIG ===
// tutte le chiavi LIVE
const stripe = new Stripe(process.env.STRIPE_KEY); // sk_live_...
const WHOP_API_KEY = process.env.WHOP_API_KEY;     // whop_live_...
const WHOP_PRODUCT_ID = process.env.WHOP_PRODUCT_ID; // prod_xxx
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET; // whsec_live_...

// Stripe richiede RAW body per verificare la firma
app.post("/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = Stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Invalid signature:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  async function grantAccess(email, externalRef) {
    // 1) get_or_create user su Whop
    const u = await fetch("https://api.whop.com/api/v1/users/get_or_create", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHOP_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email })
    });
    const user = await u.json();
    if (!u.ok || !user?.id) {
      console.error("Whop get_or_create user failed:", await u.text());
      throw new Error("whop_user_error");
    }

    // 2) crea Access Pass legato al prodotto (delivery Discord già configurato sul prodotto)
    const p = await fetch("https://api.whop.com/api/v1/access_passes", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHOP_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        user_id: user.id,
        product_id: WHOP_PRODUCT_ID,
        external_reference: externalRef
      })
    });

    if (!p.ok) {
      const t = await p.text();
      console.error("Whop create pass failed:", t);
      throw new Error("whop_pass_error");
    }
  }

  async function revokeAccess(externalRef) {
    const r = await fetch("https://api.whop.com/api/v1/access_passes/revoke", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHOP_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ external_reference: externalRef })
    });
    if (!r.ok) console.error("Whop revoke failed:", await r.text());
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        const email = s.customer_details?.email || s.customer_email;
        if (email) await grantAccess(email, s.id);
        break;
      }
      case "invoice.paid": {
        const inv = event.data.object;
        const email = inv.customer_email || inv.customer_details?.email;
        const ref = inv.subscription || inv.id;
        if (email) await grantAccess(email, ref);
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await revokeAccess(sub.id);
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object;
        const ref = inv.subscription || inv.id;
        await revokeAccess(ref);
        break;
      }
      default:
        // ignora altri eventi
        break;
    }
    res.json({ received: true });
  } catch (e) {
    console.error("handler error:", e);
    res.status(500).send("error");
  }
});

// healthcheck
app.get("/", (req, res) => res.send("OK"));

// Render assegna la porta in env PORT
app.listen(process.env.PORT || 3000, () => {
  console.log("Listening on", process.env.PORT || 3000);
});

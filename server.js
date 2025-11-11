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
app.post("/stripe-webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = Stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 1) ACK immediato (entro 1–2 ms)
  res.status(200).json({ received: true });

  // 2) Processa in background (fire-and-forget)
  setImmediate(async () => {
    try {
      const type = event.type;
      const obj = event.data.object;

      const email =
        obj.customer_email ||
        obj.customer_details?.email ||
        obj.receipt_email ||
        null;

      // helper per chiamare Whop con log
      const callWhop = async (url, payload) => {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.WHOP_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key":
              payload.external_reference || `${Date.now()}-${Math.random()}`
          },
          body: JSON.stringify(payload)
        });
        const txt = await r.text();
        console.log("[WHOP]", url, r.status, txt);
        if (!r.ok) throw new Error(`WHOP ${r.status}: ${txt}`);
        return JSON.parse(txt);
      };

      if (type === "checkout.session.completed" || type === "invoice.paid") {
        if (!email) return console.warn("[WH] no email in event", type);
        // get_or_create user
        const user = await callWhop(
          "https://api.whop.com/api/v1/users/get_or_create",
          { email }
        );
        // create pass
        await callWhop("https://api.whop.com/api/v1/access_passes", {
          user_id: user.id,
          product_id: process.env.WHOP_PRODUCT_ID,
          external_reference:
            obj.subscription || obj.id // stabile per rinnovi
        });
      } else if (
        type === "customer.subscription.deleted" ||
        type === "invoice.payment_failed"
      ) {
        await callWhop("https://api.whop.com/api/v1/access_passes/revoke", {
          external_reference: obj.subscription || obj.id
        });
      }
    } catch (e) {
      console.error("[WEBHOOK BG ERROR]", e);
    }
  });
});

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

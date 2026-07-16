// POST /api/webhook — notificação do Mercado Pago.
// Segurança: o corpo da notificação NUNCA é confiado; o pagamento é
// re-consultado direto na API do MP com o nosso token. Só marca "pago"
// se o MP confirmar status=approved com o valor certo.
const { getDb } = require("../lib/firebase");
const { PRICE, pad, telegram } = require("../lib/config");

module.exports = async (req, res) => {
  // Responde 200 sempre que possível para o MP não reenviar em loop
  try {
    const q = req.query || {};
    const b = req.body || {};
    const topic = q.type || q.topic || b.type || "";
    const id = q["data.id"] || (b.data && b.data.id) || q.id || "";
    if (!/payment/.test(topic) || !id) return res.status(200).json({ ok: true, ignored: true });

    const mp = await fetch("https://api.mercadopago.com/v1/payments/" + id, {
      headers: { "Authorization": "Bearer " + process.env.MP_ACCESS_TOKEN }
    });
    if (!mp.ok) {
      console.error("consulta MP falhou:", mp.status);
      return res.status(200).json({ ok: true }); // não força retry infinito
    }
    const pay = await mp.json();

    const n = parseInt(pay.external_reference, 10);
    if (!n) return res.status(200).json({ ok: true, ignored: true });

    if (pay.status !== "approved") {
      console.log("pagamento", id, "número", n, "status:", pay.status);
      return res.status(200).json({ ok: true, status: pay.status });
    }
    if (Number(pay.transaction_amount) < PRICE) {
      await telegram("⚠️ Pix com valor ERRADO no número " + pad(n) + ": R$ " + pay.transaction_amount + " (id " + id + "). Não confirmei — verifique.");
      return res.status(200).json({ ok: true, wrong_amount: true });
    }

    const meta = pay.metadata || {};
    const db = getDb();
    let duplicado = false;
    const result = await db.ref("nums/" + n).transaction(cur => {
      if (cur && cur.status === "pago") {
        if (String(cur.mp_pago_id) !== String(pay.id)) duplicado = true;
        return; // já vendido — não sobrescreve
      }
      return {
        status: "pago",
        nome: (cur && cur.nome) || meta.nome || "Comprador Pix",
        tel: (cur && cur.tel) || meta.tel || "",
        ts: Date.now(),
        mp_pago_id: pay.id
      };
    });

    const quando = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    if (result.committed) {
      const rec = result.snapshot.val() || {};
      await telegram("💰 PAGO ✅ (automático)\n\n🎟️ Número " + pad(n) +
        "\n👤 " + (rec.nome || "—") + "\n📱 " + (rec.tel || "—") +
        "\n💵 R$ " + Number(pay.transaction_amount).toFixed(2).replace(".", ",") +
        "\n🕒 " + quando);
    } else if (duplicado) {
      await telegram("⚠️ PAGAMENTO DUPLICADO no número " + pad(n) + " (id " + pay.id + ", " + quando + "). O número já estava vendido — estorne este Pix no Mercado Pago.");
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: false });
  }
};

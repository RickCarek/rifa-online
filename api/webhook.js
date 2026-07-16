// POST /api/webhook — notificação do Mercado Pago.
// Segurança: o corpo da notificação NUNCA é confiado; o pagamento é
// re-consultado direto na API do MP com o nosso token. Só marca "pago"
// se o MP confirmar status=approved com o valor certo.
// Um pagamento pode cobrir vários números (external_reference "5,12,73").
const { getDb } = require("../lib/firebase");
const { TOTAL, PRICE, pad, telegram } = require("../lib/config");

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

    const ns = [...new Set(String(pay.external_reference || "").split(/[^0-9]+/)
      .map(x => parseInt(x, 10)).filter(n => n >= 1 && n <= TOTAL))];
    if (!ns.length) return res.status(200).json({ ok: true, ignored: true });
    const lista = ns.map(pad).join(", ");
    const valor = Number(pay.transaction_amount).toFixed(2).replace(".", ",");

    // Estorno/contestação num Pix da rifa: pode ser sinal de token vazado — alerta imediato
    if (pay.status === "refunded" || pay.status === "charged_back") {
      await telegram("🚨 ESTORNO no Pix do(s) número(s) " + lista + " (id " + pay.id + ", R$ " + valor +
        ").\n\nSe NÃO foi você que estornou, renove o Access Token no painel do Mercado Pago AGORA.");
      return res.status(200).json({ ok: true, refund: true });
    }
    if (pay.status !== "approved") {
      console.log("pagamento", id, "números", lista, "status:", pay.status);
      return res.status(200).json({ ok: true, status: pay.status });
    }
    if (Number(pay.transaction_amount) + 0.005 < PRICE * ns.length) {
      await telegram("⚠️ Pix com valor ERRADO nos números " + lista + ": R$ " + valor +
        " (esperado R$ " + (PRICE * ns.length).toFixed(2).replace(".", ",") + ", id " + id + "). Não confirmei — verifique.");
      return res.status(200).json({ ok: true, wrong_amount: true });
    }

    const meta = pay.metadata || {};
    const db = getDb();
    const confirmados = [], duplicados = [];
    let nomeFinal = meta.nome || "Comprador Pix", telFinal = meta.tel || "";
    for (const n of ns) {
      let dup = false;
      const result = await db.ref("nums/" + n).transaction(cur => {
        if (cur && cur.status === "pago") {
          if (String(cur.mp_pago_id) !== String(pay.id)) dup = true;
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
      if (result.committed) {
        confirmados.push(n);
        const rec = result.snapshot.val() || {};
        if (rec.nome) nomeFinal = rec.nome;
        if (rec.tel) telFinal = rec.tel;
      } else if (dup) {
        duplicados.push(n);
      }
    }

    const quando = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    if (confirmados.length) {
      await telegram("💰 PAGO ✅ (automático)\n\n🎟️ Número(s): " + confirmados.map(pad).join(", ") +
        "\n👤 " + nomeFinal + "\n📱 " + (telFinal || "—") +
        "\n💵 R$ " + valor + "\n🕒 " + quando);
    }
    if (duplicados.length) {
      await telegram("⚠️ PAGAMENTO DUPLICADO no(s) número(s) " + duplicados.map(pad).join(", ") +
        " (id " + pay.id + ", " + quando + "). Já estavam vendidos — estorne este Pix no Mercado Pago.");
    }

    return res.status(200).json({ ok: true, confirmados, duplicados });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: false });
  }
};

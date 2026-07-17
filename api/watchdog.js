// GET /api/watchdog — vigia da conta Mercado Pago (disparado 1x/dia pelo Vercel Cron).
// Varre os pagamentos das últimas 30h e avisa no Telegram:
//   • resumo das vendas (batimento normal)
//   • 🚨 se existir cobrança que NÃO foi criada pela rifa (indício de token vazado)
//   • 🚨 se existir estorno/contestação
const { TOTAL, RECONHECIDOS, pad, telegram } = require("../lib/config");

module.exports = async (req, res) => {
  // Só o cron da Vercel (que envia o CRON_SECRET) pode disparar
  if (process.env.CRON_SECRET && req.headers.authorization !== "Bearer " + process.env.CRON_SECRET) {
    return res.status(401).json({ error: "não autorizado" });
  }

  try {
    const url = "https://api.mercadopago.com/v1/payments/search" +
      "?sort=date_created&criteria=desc&limit=100" +
      "&range=date_created&begin_date=NOW-30HOURS&end_date=NOW";
    const r = await fetch(url, { headers: { Authorization: "Bearer " + process.env.MP_ACCESS_TOKEN } });
    if (!r.ok) {
      await telegram("⚠️ Vigia da rifa: não consegui consultar o Mercado Pago (HTTP " + r.status +
        "). Se o token foi renovado, me atualize na Vercel.");
      return res.status(200).json({ ok: false, mp_status: r.status });
    }
    const pays = (await r.json()).results || [];

    let aprovados = 0, soma = 0;
    const estornos = [], estranhos = [];
    for (const p of pays) {
      if (RECONHECIDOS.includes(String(p.id))) continue; // já conferido pelo dono
      const n = parseInt(p.external_reference, 10);
      const daRifa = n >= 1 && n <= TOTAL && /^Rifa RRC/.test(p.description || "");
      if (!daRifa) estranhos.push(p);
      if (p.status === "approved") { aprovados++; soma += Number(p.transaction_amount) || 0; }
      if (p.status === "refunded" || p.status === "charged_back") estornos.push(p);
    }

    const fmt = v => "R$ " + Number(v || 0).toFixed(2).replace(".", ",");
    let msg;
    if (!estranhos.length && !estornos.length) {
      msg = "🛡️ Vigia diário — tudo certo ✓\n\n" +
        "Últimas 24h: " + aprovados + " número(s) pago(s), " + fmt(soma) + ".\n" +
        "Nenhum estorno e nenhuma cobrança fora da rifa criada com o seu token.";
    } else {
      msg = "🚨 VIGIA: atividade fora do padrão na conta Mercado Pago!\n";
      if (estranhos.length) {
        msg += "\n• " + estranhos.length + " pagamento(s) que NÃO são da rifa:\n" +
          estranhos.slice(0, 5).map(p => "   id " + p.id + " · " + fmt(p.transaction_amount) +
            " · " + (p.description || "sem descrição") + " · " + p.status).join("\n");
      }
      if (estornos.length) {
        msg += "\n• " + estornos.length + " estorno(s)/contestação(ões):\n" +
          estornos.slice(0, 5).map(p => "   número " + pad(parseInt(p.external_reference, 10) || 0) +
            " · id " + p.id + " · " + fmt(p.transaction_amount)).join("\n");
      }
      msg += "\n\nSe você não reconhece isso, RENOVE o Access Token no painel do Mercado Pago agora.";
    }
    await telegram(msg);
    return res.status(200).json({ ok: true, aprovados, soma: +soma.toFixed(2), estornos: estornos.length, fora_da_rifa: estranhos.length });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false });
  }
};

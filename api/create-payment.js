// POST /api/create-payment  { numeros:[...], nome, tel }  (ou { numero } — 1 só)
// Cria UMA cobrança Pix no Mercado Pago cobrindo todos os números reservados
// e devolve o QR Code + código "copia e cola" do valor somado.
const { getDb } = require("../lib/firebase");
const { TOTAL, PRICE, RESERVE_MIN, cors, pad } = require("../lib/config");

const MAX_POR_PIX = 15; // limite de números num único pagamento

// Formato de data exigido pelo Mercado Pago: 2026-07-16T14:30:00.000-03:00
function isoBR(dateMs) {
  const d = new Date(dateMs - 3 * 3600000); // desloca para UTC-3
  return d.toISOString().replace("Z", "-03:00");
}

module.exports = async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "método não permitido" });

  try {
    const { numero, numeros, nome, tel } = req.body || {};
    let ns = Array.isArray(numeros) ? numeros : (numero != null ? [numero] : []);
    ns = [...new Set(ns.map(x => parseInt(x, 10)))].filter(n => n >= 1 && n <= TOTAL).sort((a, b) => a - b);
    if (!ns.length) return res.status(400).json({ error: "Nenhum número válido." });
    if (ns.length > MAX_POR_PIX) return res.status(400).json({ error: "Máximo de " + MAX_POR_PIX + " números por Pix." });

    // Todos precisam estar com reserva ativa (nem livre, nem vendido, nem expirado)
    const db = getDb();
    const recs = {};
    const snaps = await Promise.all(ns.map(n => db.ref("nums/" + n).get()));
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i], rec = snaps[i].val();
      if (!rec || rec.status === "livre") return res.status(409).json({ error: "O número " + pad(n) + " não está reservado. Reserve primeiro." });
      if (rec.status === "pago") return res.status(409).json({ error: "O número " + pad(n) + " já foi vendido." });
      if (Date.now() > (rec.ts || 0) + RESERVE_MIN * 60000) return res.status(409).json({ error: "A reserva do número " + pad(n) + " expirou. Reserve novamente." });
      recs[n] = rec;
    }

    const auth = { "Authorization": "Bearer " + process.env.MP_ACCESS_TOKEN };

    // Reaproveita a cobrança pendente se estes exatos números já apontam pro mesmo pagamento
    // (reabrir a tela não gera Pix duplicado)
    const ids = [...new Set(ns.map(n => recs[n].mp_id).filter(Boolean))];
    if (ids.length === 1 && ns.every(n => recs[n].mp_id)) {
      const r0 = await fetch("https://api.mercadopago.com/v1/payments/" + ids[0], { headers: auth });
      if (r0.ok) {
        const p = await r0.json();
        const refNs = String(p.external_reference || "").split(/[^0-9]+/).map(Number).filter(Boolean);
        const tx0 = (p.point_of_interaction && p.point_of_interaction.transaction_data) || {};
        if (p.status === "pending" && tx0.qr_code &&
            refNs.length === ns.length && ns.every(n => refNs.includes(n)) &&
            new Date(p.date_of_expiration).getTime() > Date.now() + 60000) {
          return res.status(200).json({
            id: p.id, copia_cola: tx0.qr_code, qr_base64: tx0.qr_code_base64 || "",
            valor: p.transaction_amount, numeros: ns,
            expira_ts: Math.min(...ns.map(n => (recs[n].ts || 0) + RESERVE_MIN * 60000))
          });
        }
      }
    }

    const expiraEm = Math.min(...ns.map(n => (recs[n].ts || 0) + RESERVE_MIN * 60000));
    const total = +(PRICE * ns.length).toFixed(2);
    const body = {
      transaction_amount: total,
      description: "Rifa RRC Importados — Número(s) " + ns.map(pad).join(", "),
      payment_method_id: "pix",
      external_reference: ns.join(","),
      date_of_expiration: isoBR(expiraEm),
      notification_url: "https://" + req.headers.host + "/api/webhook",
      payer: {
        email: "comprador@rifarrc.com.br",
        first_name: String(nome || recs[ns[0]].nome || "Comprador").slice(0, 60)
      },
      metadata: { numeros: ns, nome: String(nome || recs[ns[0]].nome || ""), tel: String(tel || recs[ns[0]].tel || "") }
    };

    const mp = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/json",
        // mesma seleção + mesmas reservas → mesma cobrança
        "X-Idempotency-Key": "rifa-" + ns.join("_") + "-" + ns.reduce((s, n) => s + (recs[n].ts || 0), 0)
      },
      body: JSON.stringify(body)
    });
    const data = await mp.json();
    if (!mp.ok) {
      console.error("Mercado Pago recusou:", mp.status, JSON.stringify(data));
      return res.status(502).json({ error: "Não consegui gerar o Pix agora. Use a chave Pix manual abaixo." });
    }

    const tx = (data.point_of_interaction && data.point_of_interaction.transaction_data) || {};
    await Promise.all(ns.map(n => db.ref("nums/" + n + "/mp_id").set(data.id)));

    return res.status(200).json({
      id: data.id,
      copia_cola: tx.qr_code || "",
      qr_base64: tx.qr_code_base64 || "",
      valor: total,
      numeros: ns,
      expira_ts: expiraEm
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erro interno ao gerar o Pix." });
  }
};

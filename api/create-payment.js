// POST /api/create-payment  { numero, nome, tel }
// Cria uma cobrança Pix no Mercado Pago para um número já reservado
// e devolve o QR Code + código "copia e cola".
const { getDb } = require("../lib/firebase");
const { TOTAL, PRICE, RESERVE_MIN, cors, pad } = require("../lib/config");

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
    const { numero, nome, tel } = req.body || {};
    const n = parseInt(numero, 10);
    if (!n || n < 1 || n > TOTAL) return res.status(400).json({ error: "Número inválido." });

    // A cobrança só é criada para número com reserva ativa (evita QR de número livre/vendido)
    const db = getDb();
    const snap = await db.ref("nums/" + n).get();
    const rec = snap.val();
    if (!rec || rec.status === "livre") return res.status(409).json({ error: "Este número não está reservado. Reserve primeiro." });
    if (rec.status === "pago") return res.status(409).json({ error: "Este número já foi vendido." });
    const expiraEm = (rec.ts || 0) + RESERVE_MIN * 60000;
    if (Date.now() > expiraEm) return res.status(409).json({ error: "A reserva expirou. Reserve o número novamente." });

    const body = {
      transaction_amount: PRICE,
      description: "Rifa RRC Importados — Número " + pad(n),
      payment_method_id: "pix",
      external_reference: String(n),
      date_of_expiration: isoBR(expiraEm),
      notification_url: "https://" + req.headers.host + "/api/webhook",
      payer: {
        email: "comprador@rifarrc.com.br",
        first_name: String(nome || rec.nome || "Comprador").slice(0, 60)
      },
      metadata: { numero: n, nome: String(nome || rec.nome || ""), tel: String(tel || rec.tel || "") }
    };

    const mp = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.MP_ACCESS_TOKEN,
        "Content-Type": "application/json",
        // mesma reserva → mesma cobrança (reabrir a tela não duplica o Pix)
        "X-Idempotency-Key": "rifa-" + n + "-" + (rec.ts || 0)
      },
      body: JSON.stringify(body)
    });
    const data = await mp.json();
    if (!mp.ok) {
      console.error("Mercado Pago recusou:", mp.status, JSON.stringify(data));
      return res.status(502).json({ error: "Não consegui gerar o Pix agora. Use a chave Pix manual abaixo." });
    }

    const tx = (data.point_of_interaction && data.point_of_interaction.transaction_data) || {};
    await db.ref("nums/" + n + "/mp_id").set(data.id);

    return res.status(200).json({
      id: data.id,
      copia_cola: tx.qr_code || "",
      qr_base64: tx.qr_code_base64 || "",
      valor: PRICE,
      expira_ts: expiraEm
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erro interno ao gerar o Pix." });
  }
};

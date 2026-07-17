// POST /api/avisar — avisa o organizador no Telegram sobre uma nova reserva.
// Existe pra tirar o token do bot do HTML público: o front manda só os dados
// da reserva e o token fica em variável de ambiente aqui no backend.
// Best-effort: nunca devolve erro pro cliente por falha do Telegram.
const { TOTAL, pad, telegram, cors } = require("../lib/config");

module.exports = async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  try {
    const b = req.body || {};
    const ns = [...new Set([].concat(b.numeros || [])
      .map(x => parseInt(x, 10)).filter(n => n >= 1 && n <= TOTAL))];
    if (!ns.length) return res.status(200).json({ ok: true, ignored: true });

    const nome = String(b.nome || "—").slice(0, 60);
    const tel = String(b.tel || "—").slice(0, 25);
    const quando = new Date().toLocaleString("pt-BR",
      { timeZone: "America/Bahia", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

    await telegram("🔔 Nova reserva na rifa!\n\n" +
      "🎟️ Número" + (ns.length > 1 ? "s" : "") + " " + ns.map(pad).join(", ") + "\n" +
      "👤 " + nome + "\n" +
      "📱 " + tel + "\n" +
      "🕒 " + quando);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("avisar:", e.message);
    return res.status(200).json({ ok: true }); // best-effort
  }
};

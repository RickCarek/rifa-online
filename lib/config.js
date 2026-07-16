// Parâmetros da rifa — manter em sincronia com o topo do index.html
module.exports = {
  TOTAL: 100,
  PRICE: 9.99,
  RESERVE_MIN: 30,
  // Origens autorizadas a chamar a API (CORS)
  ORIGINS: [
    "https://rickcarek.github.io",
    "http://localhost:3000",
    "http://127.0.0.1:5500"
  ]
};

module.exports.cors = function cors(req, res) {
  const origin = req.headers.origin || "";
  if (module.exports.ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
};

module.exports.pad = n => String(n).padStart(3, "0");

// Avisa o organizador no Telegram (best-effort: erro nunca derruba o fluxo)
module.exports.telegram = async function telegram(msg) {
  const token = process.env.TG_TOKEN, chat = process.env.TG_CHAT;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: msg })
    });
  } catch (e) { console.error("telegram:", e.message); }
};

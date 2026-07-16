// Conexão única do backend com o Realtime Database (credencial de admin,
// vinda da variável de ambiente FIREBASE_SERVICE_ACCOUNT — nunca do código).
const admin = require("firebase-admin");

function getDb() {
  if (!admin.apps.length) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(svc),
      databaseURL: "https://rifa-online-bcaca-default-rtdb.firebaseio.com"
    });
  }
  return admin.database();
}

module.exports = { getDb };

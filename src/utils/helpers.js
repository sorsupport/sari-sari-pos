const crypto = require('crypto');

function generateReceiptNo() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const rand = Math.floor(100 + Math.random() * 900);
  return `RCPT-${stamp}-${rand}`;
}

function peso(amount) {
  return `₱${Number(amount).toFixed(2)}`;
}

function dateOnly(d) {
  return new Date(d).toISOString().slice(0, 10);
}

// Temporary password an admin reads out or messages to a staff member, so it
// skips look-alike characters (0/O, 1/l/I).
function tempPassword(length = 8) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

module.exports = { generateReceiptNo, peso, dateOnly, tempPassword };

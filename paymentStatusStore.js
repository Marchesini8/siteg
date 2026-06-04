const fs = require("fs");
const path = require("path");

const payments = new Map();
const storagePath = process.env.PAYMENT_STATUS_FILE
  ? path.resolve(process.env.PAYMENT_STATUS_FILE)
  : path.join(__dirname, "outputs", "payments.json");

function ensureStorageDir() {
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
}

function loadPayments() {
  try {
    const saved = JSON.parse(fs.readFileSync(storagePath, "utf8"));
    const entries = Array.isArray(saved.payments) ? saved.payments : [];

    entries.forEach((payment) => {
      if (payment?.transactionHash) payments.set(payment.transactionHash, payment);
    });
  } catch {
    // The store starts empty when there is no persisted file yet.
  }
}

function persistPayments() {
  ensureStorageDir();
  fs.writeFileSync(
    storagePath,
    JSON.stringify({ payments: Array.from(payments.values()) }, null, 2)
  );
}

loadPayments();

function savePayment(transactionHash, data = {}) {
  if (!transactionHash) return null;

  const existing = payments.get(transactionHash) || {};
  const next = {
    ...existing,
    ...data,
    transactionHash,
    updatedAt: new Date().toISOString(),
  };

  payments.set(transactionHash, next);
  persistPayments();
  return next;
}

function getPayment(transactionHash) {
  return payments.get(transactionHash) || null;
}

module.exports = {
  savePayment,
  getPayment,
};

const crypto = require("node:crypto");
const paymentStatusStore = require("./paymentStatusStore");
const orderStore = require("./orderStore");
const deliveryService = require("./deliveryService");

const PAID_STATUSES = new Set([
  "paid", "approved", "authorized", "completed", "complete", "confirmed", "success", "succeeded",
]);

function validateWebhookKey(receivedKey) {
  const expectedKey = process.env.IRONPAY_WEBHOOK_SECRET;
  if (!expectedKey) {
    const error = new Error("IRONPAY_WEBHOOK_SECRET nao configurado no .env.");
    error.statusCode = 500;
    throw error;
  }

  const received = Buffer.from(String(receivedKey || ""));
  const expected = Buffer.from(String(expectedKey));
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    const error = new Error("Chave do webhook invalida.");
    error.statusCode = 401;
    throw error;
  }
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function normalizeStatus(value = "") {
  return String(value).trim().toLowerCase();
}

function normalizeWebhookPayload(payload = {}) {
  const source = payload.data || payload.transaction || payload.payment || payload;
  const nested = [source, source.pix, source.transaction, source.payment, payload].filter(Boolean);
  const transactionHash = firstValue(...nested.flatMap((item) => [
    item.transaction_hash, item.transactionHash, item.hash, item.id,
  ]));
  const status = normalizeStatus(firstValue(source.status, source.payment_status, payload.status));
  const amount = Number(firstValue(source.amount, source.total, source.value, payload.amount) || 0);
  const paidAt = firstValue(source.paid_at, source.paidAt, source.approved_at, source.approvedAt, payload.paid_at);

  return {
    transactionHash,
    status,
    amount: Number.isFinite(amount) ? amount : 0,
    paymentMethod: firstValue(source.payment_method, source.paymentMethod, payload.payment_method) || null,
    paidAt: paidAt || null,
    isPaid: PAID_STATUSES.has(status),
  };
}

async function processWebhook(payload) {
  const normalized = normalizeWebhookPayload(payload);
  if (!normalized.transactionHash || !normalized.status) {
    const error = new Error("Payload do webhook invalido.");
    error.statusCode = 400;
    throw error;
  }

  const order = orderStore.getOrderByTransaction(normalized.transactionHash);
  if (order && normalized.amount && order.amountInCents && normalized.amount !== order.amountInCents) {
    const error = new Error("Valor do webhook nao corresponde ao pedido.");
    error.statusCode = 400;
    throw error;
  }

  paymentStatusStore.savePayment(normalized.transactionHash, normalized);
  if (order) {
    const wasPaid = order.isPaid;
    const updated = orderStore.updateOrder(order.id, {
      status: normalized.status,
      isPaid: normalized.isPaid,
      paidAt: normalized.paidAt,
    });
    if (normalized.isPaid && !wasPaid) {
      normalized.delivery = await deliveryService.deliverOrder(updated);
    }
  }
  return normalized;
}

module.exports = { validateWebhookKey, processWebhook, normalizeWebhookPayload };

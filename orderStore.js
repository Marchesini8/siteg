const fs = require("node:fs");
const path = require("node:path");

const orders = new Map();
const storagePath = process.env.ORDER_STATUS_FILE
  ? path.resolve(process.env.ORDER_STATUS_FILE)
  : path.join(__dirname, "outputs", "orders.json");

function persist() {
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  fs.writeFileSync(storagePath, JSON.stringify({ orders: [...orders.values()] }, null, 2));
}

function saveOrder(order) {
  const next = { ...order, updatedAt: new Date().toISOString() };
  orders.set(next.id, next);
  persist();
  return next;
}

function updateOrder(id, changes) {
  const existing = orders.get(id);
  return existing ? saveOrder({ ...existing, ...changes }) : null;
}

function getOrderByTransaction(transactionHash) {
  return [...orders.values()].find((order) => order.transactionHash === transactionHash) || null;
}

function addDeliveryAttempt(id, attempt) {
  const order = orders.get(id);
  if (!order) return null;
  return updateOrder(id, { deliveryAttempts: [...(order.deliveryAttempts || []), attempt] });
}

try {
  const saved = JSON.parse(fs.readFileSync(storagePath, "utf8"));
  for (const order of saved.orders || []) {
    if (order?.id) orders.set(order.id, order);
  }
} catch {
  // Start empty when the persisted order file does not exist yet.
}

module.exports = { saveOrder, updateOrder, getOrderByTransaction, addDeliveryAttempt };

const orderStore = require("./orderStore");

async function deliverOrder(order) {
  if (!order?.isPaid) {
    return { delivered: false, reason: "Pedido ainda nao pago." };
  }

  const attempt = {
    channel: "site",
    sent: true,
    reason: "Acesso confirmado no checkout.",
  };

  orderStore.addDeliveryAttempt(order.id, attempt);

  return {
    delivered: true,
    attempts: [attempt],
  };
}

module.exports = {
  deliverOrder,
};

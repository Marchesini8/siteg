const paymentStatusStore = require("./paymentStatusStore");

const FIXED_SHIPPING_AMOUNT = 0;
const DEFAULT_ITEM_TITLE = "Pagamento Taxa";
const MAX_QUANTITY = 100;

function requireEnv(name) {
  if (process.env[name]) return process.env[name];
  const error = new Error(`${name} nao configurado no .env.`);
  error.statusCode = 500;
  throw error;
}

function positiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    const error = new Error(`${fieldName} invalido.`);
    error.statusCode = 400;
    throw error;
  }
  return number;
}

function normalizeItemPrice(item) {
  const price = Number(item?.unitPrice || item?.price || item?.oldPrice || 0);
  return Number.isFinite(price) && price > 0 ? price : 0;
}

function extractPixCode(data) {
  return data.pix_code || data.pixCode || data.pix?.pix_qr_code || data.pix_qr_code || null;
}

function extractTransactionHash(data) {
  const sources = [data, data.pix, data.transaction, data.payment].filter(Boolean);
  for (const source of sources) {
    const hash = source.transaction_hash || source.transactionHash || source.hash || source.id;
    if (hash) return hash;
  }
  return null;
}

function extractPixQrImage(data) {
  const sources = [data, data.pix, data.payment].filter(Boolean);
  for (const source of sources) {
    const image = source.qr_code || source.qrCode || source.qrcode || source.qr_code_url
      || source.qrCodeUrl || source.pix_base64 || source.pixBase64
      || source.qr_code_base64 || source.qrCodeBase64;
    if (image) return image;
  }
  return null;
}

function normalizePostbackUrl(value = "") {
  const configuredUrl = String(value).trim();
  if (!configuredUrl) {
    const error = new Error("IRONPAY_POSTBACK_URL nao configurado no .env.");
    error.statusCode = 500;
    throw error;
  }

  try {
    const url = new URL(configuredUrl);
    const normalizedPath = url.pathname.replace(/\/+/g, "/");
    if (normalizedPath === "/" || normalizedPath === "" || normalizedPath === "/ironpay") {
      url.pathname = "/api/webhooks/ironpay";
    }
    if (process.env.IRONPAY_WEBHOOK_SECRET && !url.searchParams.has("webhook_secret")) {
      url.searchParams.set("webhook_secret", process.env.IRONPAY_WEBHOOK_SECRET);
    }
    return url.toString();
  } catch {
    const error = new Error("IRONPAY_POSTBACK_URL invalido.");
    error.statusCode = 500;
    throw error;
  }
}

function configuredUnitPriceInCents() {
  return positiveInteger(requireEnv("PAYMENT_AMOUNT_CENTS"), "PAYMENT_AMOUNT_CENTS");
}

exports.createPixPayment = async ({ items, customer = {}, delivery, tracking = {} }) => {
  const normalizedItems = Array.isArray(items) ? items : [];
  const fixedPriceInCents = configuredUnitPriceInCents();

  if (!customer.name || !customer.email) {
    const error = new Error("Nome e email do cliente sao obrigatorios.");
    error.statusCode = 400;
    throw error;
  }

  const cart = normalizedItems.map((item) => {
    const quantity = positiveInteger(item?.qty || item?.quantity || 1, "Quantidade");
    if (quantity > MAX_QUANTITY) {
      const error = new Error("Quantidade acima do limite permitido.");
      error.statusCode = 400;
      throw error;
    }
    const price = fixedPriceInCents;
    positiveInteger(price, "Preco");
    return {
      product_hash: requireEnv("IRONPAY_PRODUCT_HASH"),
      title: item.title || DEFAULT_ITEM_TITLE,
      cover: item.image || null,
      price,
      quantity,
      operation_type: 1,
      tangible: false,
    };
  });

  const totalInCents = cart.reduce((sum, item) => sum + item.price * item.quantity, 0)
    + FIXED_SHIPPING_AMOUNT * 100;
  if (!cart.length || totalInCents <= 0) {
    const error = new Error("Valor invalido para gerar pagamento Pix.");
    error.statusCode = 400;
    throw error;
  }

  const paymentApiUrl = requireEnv("PAYMENT_API_URL");
  const endpoint = new URL(process.env.PAYMENT_PIX_ENDPOINT || "/transactions", paymentApiUrl);
  endpoint.searchParams.set("api_token", requireEnv("PAYMENT_API_KEY"));

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        offer_hash: requireEnv("IRONPAY_OFFER_HASH"),
        amount: totalInCents,
        payment_method: "pix",
        expire_in_days: Number(process.env.IRONPAY_EXPIRE_IN_DAYS || 1),
        transaction_origin: "api",
        postback_url: normalizePostbackUrl(process.env.IRONPAY_POSTBACK_URL),
        cart,
        customer: {
          name: customer.name,
          email: customer.email,
          phone_number: customer.phone_number || customer.phone || process.env.DEFAULT_PHONE_NUMBER || "",
          document: customer.document || customer.cpf || process.env.DEFAULT_DOCUMENT || "",
          street_name: customer.street_name || delivery?.address || "",
          number: customer.number || delivery?.number || "",
          complement: customer.complement || delivery?.complement || "",
          neighborhood: customer.neighborhood || delivery?.neighborhood || process.env.DEFAULT_NEIGHBORHOOD || "",
          city: customer.city || delivery?.city || "",
          state: customer.state || delivery?.state || process.env.DEFAULT_STATE || "",
          zip_code: customer.zip_code || delivery?.zip_code || delivery?.cep || "",
        },
        tracking,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(JSON.stringify(data));
      error.statusCode = response.status;
      throw error;
    }

    const pixCode = extractPixCode(data);
    const transactionHash = extractTransactionHash(data);
    if (!pixCode || !transactionHash) {
      const error = new Error("IronPay respondeu sem codigo Pix ou identificador da transacao.");
      error.statusCode = 502;
      throw error;
    }

    paymentStatusStore.savePayment(transactionHash, {
      status: data.status || "pending",
      amount: data.amount || totalInCents,
      paymentMethod: "pix",
      isPaid: false,
      pixCode,
    });

    return {
      transaction_hash: transactionHash,
      status: data.status || "pending",
      pix_code: pixCode,
      pix_base64: extractPixQrImage(data),
      charged_total: totalInCents / 100,
      product_total: (totalInCents - FIXED_SHIPPING_AMOUNT * 100) / 100,
      shipping_total: FIXED_SHIPPING_AMOUNT,
      source: "ironpay",
    };
  } catch (error) {
    const paymentError = new Error(`Falha ao gerar Pix na IronPay: ${error.message}`);
    paymentError.statusCode = error.statusCode || 502;
    throw paymentError;
  }
};

exports.FIXED_SHIPPING_AMOUNT = FIXED_SHIPPING_AMOUNT;
exports.getPaymentStatus = (transactionHash) => paymentStatusStore.getPayment(transactionHash);

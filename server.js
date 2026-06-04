const { createReadStream, existsSync, readFileSync, statSync } = require("node:fs");
const { createServer } = require("node:http");
const { extname, join, normalize, resolve } = require("node:path");

function loadEnvFile() {
  const envPath = join(__dirname, ".env");
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    process.env[match[1]] = value;
  }
}

loadEnvFile();

const crypto = require("node:crypto");
const paymentService = require("./paymentService");
const ironpayWebhookService = require("./ironpayWebhookService");
const orderStore = require("./orderStore");

const root = resolve(__dirname);
const preferredPort = Number(process.env.PORT || 8081);
const hubToken = process.env.HUB_TOKEN || "";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".woff2": "font/woff2",
};

function resolveRequestPath(requestUrl) {
  const url = new URL(requestUrl, "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname);
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(root, requestedPath));

  if (!filePath.startsWith(root)) {
    return null;
  }

  return filePath;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        rejectBody(new Error("Payload muito grande"));
      }
    });

    request.on("end", () => resolveBody(body));
    request.on("error", rejectBody);
  });
}

async function handleCpfLookup(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }

  if (!hubToken) {
    sendJson(response, 500, { ok: false, error: "API_TOKEN_MISSING" });
    return;
  }

  try {
    const body = JSON.parse(await readRequestBody(request) || "{}");
    const cpf = String(body.cpf || "").replace(/\D/g, "");
    const birthDate = String(body.birthDate || "").trim();

    if (cpf.length !== 11 || (birthDate && !/^\d{2}\/\d{2}\/\d{4}$/.test(birthDate))) {
      sendJson(response, 400, { ok: false, error: "INVALID_INPUT" });
      return;
    }

    const params = new URLSearchParams({
      cpf,
      token: hubToken,
    });

    if (birthDate) {
      params.set("data", birthDate);
    }
    const apiResponse = await fetch(`https://ws.hubdodesenvolvedor.com.br/v2/cpf/?${params.toString()}`);
    const apiPayload = await apiResponse.json();

    if (!apiResponse.ok || apiPayload?.return !== "OK" || !apiPayload?.result) {
      sendJson(response, 502, { ok: false, error: "LOOKUP_FAILED" });
      return;
    }

    sendJson(response, 200, {
      ok: true,
      result: {
        cpf: apiPayload.result.numero_de_cpf || "",
        name: apiPayload.result.nome_da_pf || "",
        birthDate: apiPayload.result.data_nascimento || "",
        registrationDate: apiPayload.result.data_inscricao || "",
        status: apiPayload.result.situacao_cadastral || "",
        verifierDigit: apiPayload.result.digito_verificador || "",
      },
    });
  } catch (error) {
    console.error("Erro ao consultar CPF:", error.message);
    sendJson(response, 500, { ok: false, error: "SERVER_ERROR" });
  }
}

async function handleCreatePix(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }

  try {
    const body = JSON.parse(await readRequestBody(request) || "{}");
    const payment = await paymentService.createPixPayment(body);
    const order = orderStore.saveOrder({
      id: crypto.randomUUID(),
      transactionHash: payment.transaction_hash,
      amountInCents: Math.round(payment.charged_total * 100),
      status: payment.status,
      isPaid: false,
      createdAt: new Date().toISOString(),
    });
    sendJson(response, 201, { ok: true, payment, order_id: order.id });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { ok: false, error: error.message });
  }
}

async function handlePaymentStatus(request, response, url) {
  if (request.method !== "GET") {
    sendJson(response, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }
  const transactionHash = url.searchParams.get("transaction_hash");
  const payment = transactionHash ? paymentService.getPaymentStatus(transactionHash) : null;
  sendJson(response, payment ? 200 : 404, payment ? { ok: true, payment } : { ok: false, error: "NOT_FOUND" });
}

async function handleIronpayWebhook(request, response, url) {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }
  try {
    const key = request.headers["x-webhook-secret"]
      || request.headers.authorization?.replace(/^Bearer\s+/i, "")
      || url.searchParams.get("webhook_secret");
    ironpayWebhookService.validateWebhookKey(key);
    const result = await ironpayWebhookService.processWebhook(JSON.parse(await readRequestBody(request) || "{}"));
    sendJson(response, 200, { ok: true, payment: result });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { ok: false, error: error.message });
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (url.pathname === "/api/payments/pix") {
    await handleCreatePix(request, response);
    return;
  }
  if (url.pathname === "/api/payments/status") {
    await handlePaymentStatus(request, response, url);
    return;
  }
  if (url.pathname === "/api/webhooks/ironpay") {
    await handleIronpayWebhook(request, response, url);
    return;
  }
  if ((request.url || "").startsWith("/api/consulta-cpf")) {
    await handleCpfLookup(request, response);
    return;
  }

  const filePath = resolveRequestPath(request.url || "/");

  if (!filePath || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Arquivo nao encontrado");
    return;
  }

  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
  });
  createReadStream(filePath).pipe(response);
}

function startServer(port) {
  const server = createServer(handleRequest);

  server.listen(port, "0.0.0.0", () => {
    console.log(`Servidor rodando na porta ${port}`);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      const nextPort = port + 1;
      console.log(`Porta ${port} ocupada. Tentando http://127.0.0.1:${nextPort}`);
      startServer(nextPort);
      return;
    }

    throw error;
  });
}

startServer(preferredPort);

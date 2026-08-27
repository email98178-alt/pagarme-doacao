const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const PAGARME_BASE_URL = 'https://api.pagar.me/core/v5';
const MAX_PIX_CENTS = 50000;
const PIX_COOKIE_NAME = 'pix_order_token';
const PIX_VISITOR_COOKIE = 'pix_visitor_id';
const pendingPixByVisitor = new Map();

function parseCookies(header = '') {
  return String(header).split(';').reduce((cookies, chunk) => {
    const separator = chunk.indexOf('=');
    if (separator < 0) return cookies;
    const key = chunk.slice(0, separator).trim();
    const value = chunk.slice(separator + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function isSecureRequest(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function setCookie(res, name, value, { maxAge, httpOnly = false, sameSite = 'Lax', secure = false } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];
  if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if (httpOnly) parts.push('HttpOnly');
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  if (secure) parts.push('Secure');
  const current = res.getHeader('Set-Cookie');
  const cookies = current ? (Array.isArray(current) ? current : [current]) : [];
  res.setHeader('Set-Cookie', [...cookies, parts.join('; ')]);
}

function getVisitorId(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[PIX_VISITOR_COOKIE]) return cookies[PIX_VISITOR_COOKIE];
  const visitorId = crypto.randomBytes(18).toString('hex');
  setCookie(res, PIX_VISITOR_COOKIE, visitorId, {
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: true,
    secure: isSecureRequest(req),
  });
  return visitorId;
}

function getCookieSecret() {
  return String(process.env.PIX_COOKIE_SECRET || process.env.PAGARME_SECRET_KEY || 'development-pix-cookie-secret');
}

function createPixToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', getCookieSecret()).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function readPixToken(req) {
  try {
    const token = parseCookies(req.headers.cookie)[PIX_COOKIE_NAME];
    if (!token) return null;
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature) return null;
    const expected = crypto.createHmac('sha256', getCookieSecret()).update(encoded).digest('base64url');
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (typeof payload?.orderId !== 'string' || !payload.orderId) return null;
    return payload;
  } catch {
    return null;
  }
}

function savePixToken(req, res, pix) {
  if (!pix?.orderId) throw new Error('O Pagar.me não retornou o identificador do Pix.');
  setCookie(res, PIX_COOKIE_NAME, createPixToken({ orderId: pix.orderId, amount: pix.amount }), {
    maxAge: 60 * 60,
    httpOnly: true,
    secure: isSecureRequest(req),
  });
}

app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  if (req.method === 'GET' && req.path === '/') getVisitorId(req, res);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.json({ ok: true }));

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function isValidCpf(value) {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^([0-9])\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(cpf[i]) * (10 - i);
  let digit = (sum * 10) % 11;
  if (digit === 10) digit = 0;
  if (digit !== Number(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i += 1) sum += Number(cpf[i]) * (11 - i);
  digit = (sum * 10) % 11;
  if (digit === 10) digit = 0;
  return digit === Number(cpf[10]);
}

function normalizePhone(value) {
  const digits = onlyDigits(value);
  if (digits.length !== 10 && digits.length !== 11) {
    throw new Error('Informe um telefone celular válido com DDD.');
  }
  return {
    country_code: '55',
    area_code: digits.slice(0, 2),
    number: digits.slice(2),
  };
}

// Dados padrão fornecidos pelo responsável da campanha. Não são enviados ao navegador.
// Mantenha o repositório privado, pois estes dados ficarão no código do backend.
const DEFAULT_CUSTOMER = {
  name: 'Luana Rodrigues',
  email: '998111@gmail.com',
  document: '53347866860',
  phone: '11982787644',
};

function getDefaultCustomer() {
  return validateCustomer(DEFAULT_CUSTOMER);
}

function validateCustomer(customer) {
  const name = String(customer?.name || '').trim();
  const email = String(customer?.email || '').trim().toLowerCase();
  const document = onlyDigits(customer?.document);

  if (name.length < 3 || name.length > 64) {
    throw new Error('Informe seu nome completo.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 64) {
    throw new Error('Informe um e-mail válido.');
  }
  if (!isValidCpf(document)) {
    throw new Error('O CPF padrão configurado é inválido. Confirme o CPF do responsável antes de gerar o Pix.');
  }

  return {
    name,
    email,
    document,
    type: 'individual',
    phones: { mobile_phone: normalizePhone(customer?.phone) },
  };
}

function getAuthHeader() {
  const secretKey = String(process.env.PAGARME_SECRET_KEY || '').trim().replace(/^['"]|['"]$/g, '');
  if (!secretKey) throw new Error('PAGARME_SECRET_KEY não configurada no Render.');
  if (secretKey.startsWith('pk_')) throw new Error('A variável PAGARME_SECRET_KEY recebeu uma Chave Pública. Use a Chave Secreta sk_test_... ou sk_... do painel Pagar.me.');
  if (!/^sk_/.test(secretKey)) throw new Error('PAGARME_SECRET_KEY está em formato inválido. Cole somente a Chave Secreta do Pagar.me, sem Bearer, espaços ou aspas.');
  return `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;
}

async function pagarmeRequest(endpoint, options = {}) {
  const response = await fetch(`${PAGARME_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: getAuthHeader(),
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errors = Array.isArray(body?.errors) ? body.errors : Object.entries(body?.errors || {}).flatMap(([parameter, value]) => (Array.isArray(value) ? value : [value]).map((item) => ({ parameter, message: item?.message || String(item) })));
    const details = errors.map((item) => [item.parameter, item.message].filter(Boolean).join(': ')).filter(Boolean).join(' | ');
    const message = details || body?.message || 'O Pagar.me recusou a solicitação.';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

function extractPix(order) {
  const charge = order?.charges?.[0] || {};
  const transaction = charge?.last_transaction || order?.last_transaction || {};
  const paymentPix = order?.payments?.[0]?.pix || {};
  const qrCode = transaction?.qr_code || transaction?.qr_code_string || paymentPix?.qr_code || paymentPix?.qr_code_string || null;
  const qrCodeUrl = transaction?.qr_code_url || transaction?.qr_code_image_url || paymentPix?.qr_code_url || paymentPix?.qr_code_image_url || null;
  return {
    orderId: order?.id,
    chargeId: charge?.id || null,
    status: transaction?.status || charge?.status || order?.status,
    amount: order?.amount,
    qrCode,
    qrCodeUrl,
    expiresAt: transaction?.expires_at || paymentPix?.expires_at || null,
    pixAvailable: Boolean(qrCode),
  };
}

app.post('/api/pix/orders', async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    const visitorId = getVisitorId(req, res);
    const existingToken = readPixToken(req);
    if (existingToken) {
      const order = await pagarmeRequest(`/orders/${encodeURIComponent(existingToken.orderId)}`);
      const pix = extractPix(order);
      pix.reused = true;
      savePixToken(req, res, pix);
      return res.json(pix);
    }

    if (!Number.isInteger(amount) || amount < 100 || amount > MAX_PIX_CENTS) {
      return res.status(400).json({ error: 'Escolha um valor entre R$ 1,00 e R$ 500,00.' });
    }

    const pendingCreation = pendingPixByVisitor.get(visitorId);
    if (pendingCreation) {
      const pix = await pendingCreation;
      pix.reused = true;
      savePixToken(req, res, pix);
      return res.json(pix);
    }

    const creation = (async () => {
      const customer = getDefaultCustomer();
      const order = await pagarmeRequest('/orders', {
        method: 'POST',
        body: JSON.stringify({
          code: `doacao-ezequiel-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          items: [{
            amount,
            description: 'Doação para a campanha do Ezequiel',
            quantity: 1,
          }],
          customer,
          payments: [{
            payment_method: 'pix',
            pix: {
              expires_in: 3600,
              additional_information: [{ name: 'Campanha', value: 'Um lar para Ezequiel e sua esposa' }],
            },
          }],
        }),
      });
      return extractPix(order);
    })();

    pendingPixByVisitor.set(visitorId, creation);
    try {
      const pix = await creation;
      savePixToken(req, res, pix);
      return res.status(201).json(pix);
    } finally {
      pendingPixByVisitor.delete(visitorId);
    }
  } catch (error) {
    console.error('Erro ao criar ou reaproveitar Pix:', error.message);
    return res.status(error.status && error.status < 500 ? error.status : 502).json({ error: error.message });
  }
});

app.get('/api/pix/orders/:orderId', async (req, res) => {
  try {
    const order = await pagarmeRequest(`/orders/${encodeURIComponent(req.params.orderId)}`);
    return res.json(extractPix(order));
  } catch (error) {
    console.error('Erro ao consultar Pix:', error.message);
    return res.status(error.status && error.status < 500 ? error.status : 502).json({ error: error.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Servidor iniciado na porta ${PORT}`));
}

module.exports = app;

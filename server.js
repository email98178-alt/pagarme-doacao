const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const PAGARME_BASE_URL = 'https://api.pagar.me/core/v5';

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.json({ ok: true }));

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
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
  if (document.length !== 11) {
    throw new Error('Informe um CPF válido com 11 dígitos.');
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
  const secretKey = process.env.PAGARME_SECRET_KEY;
  if (!secretKey) throw new Error('PAGARME_SECRET_KEY não configurada no Render.');
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
    const message = body?.message || body?.errors?.[0]?.message || 'O Pagar.me recusou a solicitação.';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

function extractPix(order) {
  const charge = order?.charges?.[0];
  const transaction = charge?.last_transaction || {};
  return {
    orderId: order?.id,
    chargeId: charge?.id,
    status: transaction?.status || charge?.status || order?.status,
    amount: order?.amount,
    qrCode: transaction?.qr_code || null,
    qrCodeUrl: transaction?.qr_code_url || null,
    expiresAt: transaction?.expires_at || null,
  };
}

app.post('/api/pix/orders', async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    if (!Number.isInteger(amount) || amount < 100 || amount > 100000000) {
      return res.status(400).json({ error: 'Escolha um valor entre R$ 1,00 e R$ 1.000.000,00.' });
    }

    const customer = getDefaultCustomer();
    const order = await pagarmeRequest('/orders', {
      method: 'POST',
      body: JSON.stringify({
        code: `doacao-ezequiel-${Date.now()}`,
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

    return res.status(201).json(extractPix(order));
  } catch (error) {
    console.error('Erro ao criar Pix:', error.message);
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

app.listen(PORT, () => console.log(`Servidor iniciado na porta ${PORT}`));

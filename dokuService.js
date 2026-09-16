// dokuService.js
const crypto = require('crypto');
const axios = require('axios');

const DOKU_CLIENT_ID = process.env.DOKU_CLIENT_ID;
const DOKU_SECRET_KEY = process.env.DOKU_SECRET_KEY;
const IS_PRODUCTION = process.env.DOKU_IS_PRODUCTION === 'true';

const DOKU_BASE_URL = IS_PRODUCTION
  ? 'https://api.doku.com'
  : 'https://api-sandbox.doku.com';

function generateDigest(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('base64');
}

function generateSignature(clientId, requestId, requestTimestamp, requestTarget, digest, secretKey) {
  let rawSignature = `Client-Id:${clientId}\n` +
                     `Request-Id:${requestId}\n` +
                     `Request-Timestamp:${requestTimestamp}\n` +
                     `Request-Target:${requestTarget}`;
  
  if (digest) {
    rawSignature += `\nDigest:${digest}`;
  }

  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(rawSignature);
  return 'HMACSHA256=' + hmac.digest('base64');
}

async function createDokuPaymentLink({ invoiceNumber, amount, customerName, customerEmail, callbackUrl }) {
  const requestTarget = '/checkout/v1/payment';
  const requestId = `REQ-${Date.now()}`;
  const requestTimestamp = new Date().toISOString().slice(0, 19) + 'Z';

  const payload = {
    order: {
      invoice_number: invoiceNumber,
      amount: amount,
      callback_url: callbackUrl
    },
    payment: {
      payment_due_date: 60
    },
    customer: {
      name: customerName,
      email: customerEmail
    }
  };

  const digest = generateDigest(payload);
  const signature = generateSignature(
    DOKU_CLIENT_ID,
    requestId,
    requestTimestamp,
    requestTarget,
    digest,
    DOKU_SECRET_KEY
  );

  const headers = {
    'Client-Id': DOKU_CLIENT_ID,
    'Request-Id': requestId,
    'Request-Timestamp': requestTimestamp,
    'Signature': signature,
    'Content-Type': 'application/json'
  };

  try {
    const response = await axios.post(`${DOKU_BASE_URL}${requestTarget}`, payload, { headers });
    return response.data.response.payment.url;
  } catch (error) {
    console.error('[DOKU API Error]:', error.response ? error.response.data : error.message);
    throw new Error('Gagal membuat link pembayaran DOKU');
  }
}

function verifyDokuSignature(headers, body, requestTarget) {
  const clientId = headers['client-id'];
  const requestId = headers['request-id'];
  const requestTimestamp = headers['request-timestamp'];
  const incomingSignature = headers['signature'];

  const digest = generateDigest(body);
  const calculatedSignature = generateSignature(
    clientId,
    requestId,
    requestTimestamp,
    requestTarget,
    digest,
    DOKU_SECRET_KEY
  );

  return incomingSignature === calculatedSignature;
}

module.exports = {
  createDokuPaymentLink,
  verifyDokuSignature
};

const router = require('express').Router();
const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/schema');
const auth = require('../middleware/auth');
const { err } = require('../middleware/error');
const logger = require('../logger');

const STELLAR_SERVICE_URL = process.env.STELLAR_SERVICE_URL || null;

// POST /api/payments/intent — create a payment intent
router.post('/intent', auth, async (req, res) => {
  const schema = z.object({
    amount: z.number().positive(),
    destination: z.string().min(1),
    orderId: z.number().int().positive().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return err(res, 400, parsed.error.errors[0].message, 'validation_error');

  const { amount, destination, orderId } = parsed.data;
  const intentId = uuidv4();

  try {
    const { rows } = await db.query(
      `INSERT INTO payment_records (intent_id, order_id, amount, destination, status)
       VALUES ($1,$2,$3,$4,'pending') RETURNING *`,
      [intentId, orderId || null, amount, destination]
    );
    logger.info('Payment intent created', { intentId, amount, destination, userId: req.user.id });
    res.status(201).json({ success: true, data: rows[0] });
  } catch (e) {
    return err(res, 500, e.message, 'intent_create_error');
  }
});

// POST /api/payments/confirm — verify txHash on Stellar and confirm payment
router.post('/confirm', auth, async (req, res) => {
  const schema = z.object({
    intentId: z.string().uuid(),
    txHash: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return err(res, 400, parsed.error.errors[0].message, 'validation_error');

  const { intentId, txHash } = parsed.data;

  try {
    const { rows: intentRows } = await db.query(
      'SELECT * FROM payment_records WHERE intent_id = $1',
      [intentId]
    );
    if (!intentRows[0]) return err(res, 404, 'Payment intent not found', 'intent_not_found');

    const intent = intentRows[0];
    if (intent.status === 'confirmed') {
      return res.json({ success: true, data: intent, message: 'Already confirmed' });
    }

    // Verify transaction on Stellar network
    let verified = false;
    let verifyError = null;

    if (STELLAR_SERVICE_URL) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(`${STELLAR_SERVICE_URL}/verify/${txHash}`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (response.ok) {
          const txData = await response.json();
          // Verify amount and destination match
          const amountMatch = Math.abs(parseFloat(txData.amount) - intent.amount) < 0.0001;
          const destMatch = txData.destination === intent.destination;
          if (amountMatch && destMatch) {
            verified = true;
          } else {
            logger.warn('Payment verification mismatch', {
              intentId, txHash,
              expectedAmount: intent.amount, gotAmount: txData.amount,
              expectedDest: intent.destination, gotDest: txData.destination,
            });
            return err(res, 422, 'Transaction amount or destination does not match intent', 'verification_mismatch');
          }
        } else {
          verifyError = `Stellar service returned ${response.status}`;
        }
      } catch (fetchErr) {
        verifyError = fetchErr.name === 'AbortError' ? 'Stellar service timeout' : fetchErr.message;
        logger.warn('Stellar service unavailable', { error: verifyError, intentId });
      }
    } else {
      // No stellar-service configured — accept txHash as-is (dev mode)
      verified = true;
      logger.warn('STELLAR_SERVICE_URL not configured, skipping on-chain verification', { intentId });
    }

    if (!verified) {
      return err(res, 503, `Stellar service unavailable: ${verifyError}`, 'stellar_service_unavailable');
    }

    const confirmedAt = new Date().toISOString();
    const { rows: updated } = await db.query(
      `UPDATE payment_records SET status='confirmed', tx_hash=$1, confirmed_at=$2, updated_at=$2
       WHERE intent_id=$3 RETURNING *`,
      [txHash, confirmedAt, intentId]
    );

    // Also update the linked order if present
    if (intent.order_id) {
      await db.query(
        `UPDATE orders SET tx_hash=$1, confirmed_at=$2, payment_status='confirmed' WHERE id=$3`,
        [txHash, confirmedAt, intent.order_id]
      );
    }

    logger.info('Payment confirmed', { intentId, txHash, confirmedAt, userId: req.user.id });
    res.json({ success: true, data: updated[0] });
  } catch (e) {
    return err(res, 500, e.message, 'confirm_error');
  }
});

// GET /api/payments/status/:intentId
router.get('/status/:intentId', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM payment_records WHERE intent_id = $1',
      [req.params.intentId]
    );
    if (!rows[0]) return err(res, 404, 'Payment intent not found', 'intent_not_found');
    res.json({ success: true, data: rows[0] });
  } catch (e) {
    return err(res, 500, e.message, 'status_fetch_error');
  }
});

module.exports = router;

// Offer endpoints, used by offer.html (the page the email link opens). No JWT: the
// single-use token in the link is the credential. GET never changes anything, because
// email scanners open links on their own; only the page's button sends the POST.

import { Router } from 'express';
import * as controller from './offers.controller.js';
import { getOfferRules, respondRules } from './offers.validation.js';

const router = Router();

/**
 * @swagger
 * /offers/{token}:
 *   get:
 *     summary: Show the offer behind an email link
 *     tags: [Offers]
 *     security: []
 *     parameters:
 *       - { in: path, name: token, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: The offer
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 officeHour:
 *                   type: object
 *                   properties:
 *                     courseCode: { type: string }
 *                     startsAt: { type: string, format: date-time }
 *                     endsAt: { type: string, format: date-time }
 *                     location: { type: string }
 *                 expiresAt: { type: string, format: date-time }
 *                 status:
 *                   type: string
 *                   enum: [PENDING, WAITING, BOOKED, DECLINED, EXPIRED, CANCELLED]
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/offers/:token', getOfferRules, controller.getOffer);

/**
 * @swagger
 * /offers/{token}/respond:
 *   post:
 *     summary: Answer an offer (once)
 *     description: >
 *       BOOKED: the slot is yours. WAITING: you said yes, but a higher-ranked student
 *       has not answered yet; you get an email if you win. DECLINED: you said no.
 *       NOT_AWARDED: you said yes but could not get it.
 *     tags: [Offers]
 *     security: []
 *     parameters:
 *       - { in: path, name: token, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [interested]
 *             properties:
 *               interested: { type: boolean, example: true }
 *     responses:
 *       200:
 *         description: Answer recorded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, enum: [BOOKED, WAITING, DECLINED, NOT_AWARDED] }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { description: Already answered, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       410: { description: Expired or no longer available, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/offers/:token/respond', respondRules, controller.respond);

export default router;

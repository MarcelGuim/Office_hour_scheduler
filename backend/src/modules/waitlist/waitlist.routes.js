// Waitlist (student).

import { Router } from 'express';
import * as controller from './waitlist.controller.js';
import { joinRules, idParamRules } from './waitlist.validation.js';
import { requireRole } from '../auth/auth.middleware.js';

const router = Router();
const student = requireRole('STUDENT');

/**
 * @swagger
 * /student/waitlist:
 *   post:
 *     summary: Join the waitlist for one or more taken office hours (student)
 *     description: >
 *       All listed office hours must be of the same course and the same day (Toronto
 *       time), and all must be unavailable. Any one of them will do. One entry per
 *       course per day; to change the list, leave and join again (back of the queue).
 *     tags: [Waitlist]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [officeHourIds]
 *             properties:
 *               officeHourIds: { type: array, items: { type: string, format: uuid } }
 *     responses:
 *       201:
 *         description: Joined
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 courseId: { type: string }
 *                 sessionDate: { type: string, format: date }
 *                 officeHourIds: { type: array, items: { type: string } }
 *                 joinedAt: { type: string, format: date-time }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { description: 'A slot is free, already mine, or I already have a booking or an entry that day', content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   get:
 *     summary: My waitlist entries (student)
 *     tags: [Waitlist]
 *     responses:
 *       200:
 *         description: My entries; offerPending is true while an emailed offer awaits my answer
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id: { type: string }
 *                   courseId: { type: string }
 *                   courseCode: { type: string }
 *                   sessionDate: { type: string, format: date }
 *                   joinedAt: { type: string, format: date-time }
 *                   officeHourIds: { type: array, items: { type: string } }
 *                   officeHours: { type: array, items: { type: object } }
 *                   offerPending: { type: boolean }
 */
router.post('/student/waitlist', student, joinRules, controller.join);
router.get('/student/waitlist', student, controller.listMyEntries);

/**
 * @swagger
 * /student/waitlist/{id}:
 *   delete:
 *     summary: Leave the waitlist (whole entry) (student)
 *     tags: [Waitlist]
 *     parameters: [{ $ref: '#/components/parameters/idPath' }]
 *     responses:
 *       204: { description: Left }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.delete('/student/waitlist/:id', student, idParamRules, controller.leave);

export default router;

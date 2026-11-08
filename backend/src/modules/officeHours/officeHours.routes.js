// Office hours (professor) and bookings (student).

import { Router } from 'express';
import * as controller from './officeHours.controller.js';
import { createSlotRules, listSlotsRules, idParamRules, bookRules } from './officeHours.validation.js';
import { requireRole } from '../auth/auth.middleware.js';

const router = Router();
const professor = requireRole('PROFESSOR');
const student = requireRole('STUDENT');

/**
 * @swagger
 * components:
 *   parameters:
 *     courseIdQuery: { in: query, name: courseId, schema: { type: string, format: uuid } }
 *     fromQuery: { in: query, name: from, schema: { type: string, format: date-time }, description: 'Slots starting at or after this time' }
 *     toQuery: { in: query, name: to, schema: { type: string, format: date-time }, description: 'Slots starting before this time' }
 *     idPath: { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *   schemas:
 *     ProfessorSlot:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid }
 *         courseId: { type: string, format: uuid }
 *         courseCode: { type: string }
 *         startsAt: { type: string, format: date-time }
 *         endsAt: { type: string, format: date-time }
 *         location: { type: string }
 *         sessionDate: { type: string, format: date, description: Toronto calendar day }
 *         cancelled: { type: boolean }
 *         bookedBy: { type: object, nullable: true, properties: { studentId: { type: string }, name: { type: string } } }
 *         waitlisted: { type: integer }
 *         offerRoundOpen: { type: boolean }
 */

/**
 * @swagger
 * /professor/office-hours:
 *   post:
 *     summary: Create one bookable office hour (professor)
 *     tags: [Office hours]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [courseId, startsAt, endsAt, location]
 *             properties:
 *               courseId: { type: string, format: uuid }
 *               startsAt: { type: string, format: date-time, example: '2026-11-12T15:00:00Z' }
 *               endsAt: { type: string, format: date-time, example: '2026-11-12T15:30:00Z' }
 *               location: { type: string, example: BA 1234 }
 *     responses:
 *       201: { description: Created }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   get:
 *     summary: List my office hours with booking state (professor)
 *     tags: [Office hours]
 *     parameters:
 *       - $ref: '#/components/parameters/courseIdQuery'
 *       - $ref: '#/components/parameters/fromQuery'
 *       - $ref: '#/components/parameters/toQuery'
 *     responses:
 *       200:
 *         description: My office hours, including cancelled ones
 *         content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/ProfessorSlot' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/professor/office-hours', professor, createSlotRules, controller.createSlot);
router.get('/professor/office-hours', professor, listSlotsRules, controller.listProfessorSlots);

/**
 * @swagger
 * /professor/office-hours/{id}:
 *   get:
 *     summary: One office hour with its waitlist (professor)
 *     tags: [Office hours]
 *     parameters: [{ $ref: '#/components/parameters/idPath' }]
 *     responses:
 *       200:
 *         description: The office hour; waitlist is in queue order
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ProfessorSlot'
 *                 - type: object
 *                   properties:
 *                     waitlist:
 *                       type: array
 *                       items: { type: object, properties: { studentId: { type: string }, name: { type: string }, joinedAt: { type: string, format: date-time } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     summary: Cancel an office hour (professor)
 *     description: Emails the booked student, stops any offer round, removes the slot from waitlists. Sends no offers.
 *     tags: [Office hours]
 *     parameters: [{ $ref: '#/components/parameters/idPath' }]
 *     responses:
 *       204: { description: Cancelled }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/professor/office-hours/:id', professor, idParamRules, controller.getProfessorSlot);
router.delete('/professor/office-hours/:id', professor, idParamRules, controller.cancelSlot);

/**
 * @swagger
 * /student/office-hours:
 *   get:
 *     summary: Upcoming office hours of my courses (student)
 *     tags: [Bookings]
 *     parameters:
 *       - $ref: '#/components/parameters/courseIdQuery'
 *       - $ref: '#/components/parameters/fromQuery'
 *       - $ref: '#/components/parameters/toQuery'
 *     responses:
 *       200:
 *         description: >
 *           available is false when booked or while an offer round is running.
 *           myStatus is NONE, BOOKED or WAITLISTED. No other students' names.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id: { type: string, format: uuid }
 *                   courseId: { type: string, format: uuid }
 *                   courseCode: { type: string }
 *                   startsAt: { type: string, format: date-time }
 *                   endsAt: { type: string, format: date-time }
 *                   location: { type: string }
 *                   sessionDate: { type: string, format: date }
 *                   available: { type: boolean }
 *                   myStatus: { type: string, enum: [NONE, BOOKED, WAITLISTED] }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/student/office-hours', student, listSlotsRules, controller.listStudentSlots);

/**
 * @swagger
 * /student/bookings:
 *   post:
 *     summary: Book an office hour (student)
 *     tags: [Bookings]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [officeHourId], properties: { officeHourId: { type: string, format: uuid } } }
 *     responses:
 *       201:
 *         description: Booked. The booking id is the office hour id.
 *         content: { application/json: { schema: { type: object, properties: { id: { type: string }, officeHourId: { type: string } } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409:
 *         description: >
 *           Taken (body {"error":"taken","canJoinWaitlist":true}), already booked by me,
 *           or I already have an office hour for this course that day
 *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
 *   get:
 *     summary: My bookings, newest first, including ones the professor cancelled (student)
 *     tags: [Bookings]
 *     responses:
 *       200:
 *         description: My bookings
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id: { type: string }
 *                   officeHourId: { type: string }
 *                   courseCode: { type: string }
 *                   startsAt: { type: string, format: date-time }
 *                   endsAt: { type: string, format: date-time }
 *                   location: { type: string }
 *                   cancelled: { type: boolean }
 */
router.post('/student/bookings', student, bookRules, controller.book);
router.get('/student/bookings', student, controller.listBookings);

/**
 * @swagger
 * /student/bookings/{id}:
 *   delete:
 *     summary: Cancel my booking (student)
 *     description: The id is the office hour id. If anyone is waiting, an offer round starts.
 *     tags: [Bookings]
 *     parameters: [{ $ref: '#/components/parameters/idPath' }]
 *     responses:
 *       204: { description: Cancelled }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.delete('/student/bookings/:id', student, idParamRules, controller.cancelBooking);

export default router;

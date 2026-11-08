// Courses and enrollments. Professors manage their courses; students browse and enroll.

import { Router } from 'express';
import * as controller from './courses.controller.js';
import { createCourseRules, browseCoursesRules, enrollRules, enrollmentIdRules } from './courses.validation.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';

const router = Router();

/**
 * @swagger
 * components:
 *   responses:
 *     Unauthorized: { description: Missing or invalid token, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *     Forbidden: { description: Wrong role or not the owner, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *     BadRequest: { description: Invalid field, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *     NotFound: { description: Not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */

/**
 * @swagger
 * /professor/courses:
 *   post:
 *     summary: Create a course (professor)
 *     tags: [Courses]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code, name]
 *             properties:
 *               code: { type: string, example: ECE1779, description: 'Stored uppercase; must be unique' }
 *               name: { type: string, example: Introduction to Cloud Computing }
 *     responses:
 *       201:
 *         description: Course created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, format: uuid }
 *                 code: { type: string }
 *                 name: { type: string }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { description: Course code already exists, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   get:
 *     summary: List my courses (professor)
 *     tags: [Courses]
 *     responses:
 *       200:
 *         description: My courses
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id: { type: string, format: uuid }
 *                   code: { type: string }
 *                   name: { type: string }
 *                   enrolledCount: { type: integer }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/professor/courses', requireRole('PROFESSOR'), createCourseRules, controller.createCourse);
router.get('/professor/courses', requireRole('PROFESSOR'), controller.listMyCourses);

/**
 * @swagger
 * /courses:
 *   get:
 *     summary: Browse all courses (any logged-in user)
 *     tags: [Courses]
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Text contained in the code or the name (case-insensitive)
 *     responses:
 *       200:
 *         description: Courses
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id: { type: string, format: uuid }
 *                   code: { type: string }
 *                   name: { type: string }
 *                   professorName: { type: string }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/courses', requireAuth, browseCoursesRules, controller.browseCourses);

/**
 * @swagger
 * /student/enrollments:
 *   post:
 *     summary: Enroll in a course (student)
 *     tags: [Enrollments]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [courseId]
 *             properties:
 *               courseId: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: Enrolled
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, format: uuid }
 *                 courseId: { type: string, format: uuid }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { description: Already enrolled, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   get:
 *     summary: List my courses (student)
 *     tags: [Enrollments]
 *     responses:
 *       200:
 *         description: My enrollments
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id: { type: string, format: uuid, description: Enrollment id }
 *                   courseId: { type: string, format: uuid }
 *                   code: { type: string }
 *                   name: { type: string }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/student/enrollments', requireRole('STUDENT'), enrollRules, controller.enroll);
router.get('/student/enrollments', requireRole('STUDENT'), controller.listMyEnrollments);

/**
 * @swagger
 * /student/enrollments/{id}:
 *   delete:
 *     summary: Drop a course (student)
 *     description: >
 *       Releases my upcoming bookings in the course (each freed slot is offered to its
 *       waitlist), withdraws my waitlist entries for it, and cancels my pending offers.
 *     tags: [Enrollments]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid }, description: Enrollment id }
 *     responses:
 *       204: { description: Dropped }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.delete('/student/enrollments/:id', requireRole('STUDENT'), enrollmentIdRules, controller.dropCourse);

export default router;

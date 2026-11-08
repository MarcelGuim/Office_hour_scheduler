// Auth endpoints. Public: no JWT needed (security: [] in each Swagger block).

import { Router } from 'express';
import * as controller from './auth.controller.js';
import { registerRules, loginRules } from './auth.validation.js';

const router = Router();

/**
 * @swagger
 * components:
 *   schemas:
 *     Session:
 *       type: object
 *       properties:
 *         token: { type: string, description: 'Access JWT. Paste it into Authorize.' }
 *         expiresIn: { type: integer, example: 900, description: Seconds until the token expires }
 *         user:
 *           type: object
 *           properties:
 *             id: { type: string, format: uuid }
 *             name: { type: string, example: Ana }
 *             role: { type: string, enum: [PROFESSOR, STUDENT] }
 */

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Create a student account
 *     description: Professors cannot register; they are seeded by the team.
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password]
 *             properties:
 *               name: { type: string, example: Ana }
 *               email: { type: string, example: ana@example.com }
 *               password: { type: string, example: correct-horse-battery, description: 8 characters to 72 bytes }
 *     responses:
 *       201:
 *         description: Account created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, format: uuid }
 *                 name: { type: string }
 *                 email: { type: string }
 *                 role: { type: string, example: STUDENT }
 *       400: { description: Invalid field, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       409: { description: Email already registered, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/auth/register', registerRules, controller.register);

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Log in
 *     description: >
 *       Returns an access token (15 minutes) in the body and sets a refresh-token
 *       cookie (httpOnly, path /auth, 7 days) used by /auth/refresh.
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, example: ana@example.com }
 *               password: { type: string, example: correct-horse-battery }
 *     responses:
 *       200:
 *         description: Logged in
 *         content: { application/json: { schema: { $ref: '#/components/schemas/Session' } } }
 *       400: { description: Invalid field, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       401: { description: Wrong email or password, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/auth/login', loginRules, controller.login);

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     summary: Get a new access token
 *     description: >
 *       Uses the refresh-token cookie set by login (the browser sends it automatically).
 *       The cookie is replaced by a new one; the old one stops working. Presenting an
 *       already-used refresh token ends all of that user's sessions.
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       200:
 *         description: New session
 *         content: { application/json: { schema: { $ref: '#/components/schemas/Session' } } }
 *       401: { description: Missing, invalid, expired or reused refresh token, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/auth/refresh', controller.refresh);

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Log out
 *     description: >
 *       Revokes the refresh-token cookie and clears it. The current access token
 *       stays valid until it expires (at most 15 minutes). Always 204, even when
 *       already logged out.
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       204: { description: Logged out }
 */
router.post('/auth/logout', controller.logout);

export default router;

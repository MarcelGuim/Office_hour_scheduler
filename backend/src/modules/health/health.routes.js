// Entry point of the health module: URL, Swagger documentation, validation (none
// here: the endpoint takes no input), then the controller.

import { Router } from 'express';
import { getHealth } from './health.controller.js';

const router = Router();

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Readiness check
 *     description: >
 *       Used by Kubernetes as the readiness probe. Returns 503 when the database is
 *       unreachable or the pod is shutting down, so the load balancer stops sending
 *       it traffic. Not to be used as the liveness probe.
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: This pod can serve requests
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: ok }
 *       503:
 *         description: Database unreachable or shutting down
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/health', getHealth);

export default router;

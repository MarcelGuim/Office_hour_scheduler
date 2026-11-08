// Builds the Express application. Kept separate from server.js so tests can use the
// app without opening a network port or starting the background loops.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import healthRoutes from './modules/health/health.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import coursesRoutes from './modules/courses/courses.routes.js';
import officeHoursRoutes from './modules/officeHours/officeHours.routes.js';
import waitlistRoutes from './modules/waitlist/waitlist.routes.js';
import offersRoutes from './modules/offers/offers.routes.js';
import mailboxRoutes from './email/mailbox.routes.js';
import { getConfig } from './config.js';
import { setupSwagger } from './swagger.js';
import { errorHandler, notFoundHandler } from './errors.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by'); // don't advertise the framework in every response
  app.locals.shuttingDown = false;

  app.use(requestLogger);
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser()); // req.cookies, for the refresh token

  setupSwagger(app); // /docs
  app.use(express.static(publicDir)); // the frontend: /, /student.html, /js/...

  // One router per module (src/modules/<name>/<name>.routes.js).
  app.use(healthRoutes);
  app.use(authRoutes);
  app.use(coursesRoutes);
  app.use(officeHoursRoutes);
  app.use(waitlistRoutes);
  app.use(offersRoutes);
  if (getConfig().devMailbox) app.use(mailboxRoutes); // local testing only

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

// One line per request on stdout, which `kubectl logs` shows. Health checks are
// skipped: Kubernetes calls them every few seconds and they would drown everything else.
// Swagger UI's files (/docs/...) and the frontend's static files are skipped too.
function requestLogger(req, res, next) {
  if (req.path === '/health' || req.path.startsWith('/docs') || isStaticFile(req)) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  next();
}

function isStaticFile(req) {
  return req.method === 'GET' && (req.path === '/' || /\.(html|js|css|ico|png|svg)$/.test(req.path));
}

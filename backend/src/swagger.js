// Swagger UI at /docs, built from the @swagger comments in every
// src/modules/**/*.routes.js. The raw OpenAPI document is at /docs.json.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import swaggerJSDoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

const spec = swaggerJSDoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Office-hours scheduler API',
      version: '0.1.0',
      description:
        'Log in with POST /auth/login, then press Authorize and paste the token to call protected endpoints.',
    },
    // Relative URL: the same document works on localhost, minikube and DigitalOcean.
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'string', example: 'not found' } },
        },
      },
    },
    // Every endpoint needs the JWT unless its comment says `security: []`.
    security: [{ bearerAuth: [] }],
  },
  // Absolute path, so it works whatever directory the process starts in.
  apis: [path.join(srcDir, 'modules', '**', '*.routes.js')],
});

export function setupSwagger(app) {
  app.get('/docs.json', (req, res) => res.json(spec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));
}

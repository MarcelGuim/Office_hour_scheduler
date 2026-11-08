// All configuration comes from environment variables, read once.
// A missing or invalid variable stops the process with a clear message,
// instead of failing later on the first request.

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function integer(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function boolean(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(`Environment variable ${name} must be "true" or "false", got "${raw}"`);
  }
  return raw === 'true';
}

// Connection settings for PostgreSQL. Separate fields rather than one URL, so a
// password with special characters needs no escaping. Same variable names as .env,
// the Compose file and the Kubernetes Secret. Kept separate from the rest so the
// migration runner needs only the database variables.
export function databaseConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: integer('DB_PORT', 5432),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: required('DB_NAME'),
  };
}

// Read on its own so the seed script works without the full app configuration.
export function bcryptCost() {
  return integer('BCRYPT_COST', 10);
}

function loadConfig() {
  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret.length < 32) {
    // HS256 with a short secret can be brute-forced offline from any issued token.
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  return {
    port: integer('PORT', 8080),
    database: databaseConfig(),

    // Auth (docs/design.md section 6)
    jwtSecret,
    accessTokenTtlSeconds: integer('ACCESS_TOKEN_TTL_SECONDS', 900), // 15 minutes
    refreshTokenTtlDays: integer('REFRESH_TOKEN_TTL_DAYS', 7),
    cookieSecure: boolean('COOKIE_SECURE', false), // true only once HTTPS exists
    bcryptCost: bcryptCost(),

    // Offer rounds (docs/design.md section 4); used from the offers step onwards.
    offerBatchSize: integer('OFFER_BATCH_SIZE', 3),
    offerWindowSeconds: integer('OFFER_WINDOW_SECONDS', 300),
    workerIntervalMs: integer('WORKER_INTERVAL_MS', 2000),
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'http://localhost:8080').replace(/\/$/, ''),

    // Email. Without SMTP_USER, emails are printed to the log instead of sent.
    smtp: process.env.SMTP_USER
      ? {
          host: process.env.SMTP_HOST || 'smtp.gmail.com',
          port: integer('SMTP_PORT', 465),
          user: process.env.SMTP_USER,
          password: required('SMTP_APP_PASSWORD'),
          from: process.env.EMAIL_FROM || process.env.SMTP_USER,
        }
      : null,
    outboxIntervalMs: integer('OUTBOX_INTERVAL_MS', 2000),
    // Local testing only: GET /dev/mailbox lists queued emails (offer links included)
    // without authentication. Never enable it in the cluster.
    devMailbox: boolean('DEV_MAILBOX', false),
  };
}

let cached;

// The configuration, read from the environment on first use.
export function getConfig() {
  if (!cached) cached = loadConfig();
  return cached;
}

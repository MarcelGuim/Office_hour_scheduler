// Model: the SQL for this module, and nothing else. The only file that talks to
// PostgreSQL. (Other modules' models also take an optional `client` argument, so a
// service can run several model calls inside one transaction.)

import { query } from '../../db.js';

export async function pingDatabase() {
  await query('SELECT 1');
}

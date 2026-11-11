// Waitlist controller.

import { matchedData } from 'express-validator';
import * as service from './waitlist.services.js';

export async function join(req, res) {
  const entry = await service.join({ studentId: req.user.id, officeHourIds: req.body.officeHourIds });
  return res.status(201).json(entry);
}

export async function listMyEntries(req, res) {
  return res.status(200).json(await service.listMyEntries(req.user.id));
}

export async function leave(req, res) {
  const { id } = matchedData(req, { locations: ['params'] });
  await service.leave({ studentId: req.user.id, entryId: id });
  return res.status(204).end();
}

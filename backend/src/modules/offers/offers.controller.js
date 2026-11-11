// Offer links: the page opened from the email calls these. The token is in the path.

import { matchedData } from 'express-validator';
import * as service from './offers.services.js';

export async function getOffer(req, res) {
  const { token } = matchedData(req, { locations: ['params'] });
  return res.status(200).json(await service.getOffer(token));
}

export async function respond(req, res) {
  const { token } = matchedData(req, { locations: ['params'] });
  return res.status(200).json(await service.respond(token, req.body.interested));
}

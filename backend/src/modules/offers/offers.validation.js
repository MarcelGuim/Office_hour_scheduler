// Request-shape rules for the offer endpoints.

import { body, param } from 'express-validator';
import { validate } from '../../validation.js';

// The token is not format-checked here: any value is hashed and looked up, so a
// malformed token gets the same 404 as an unknown one.
const token = () => param('token').isString();

export const getOfferRules = [token(), validate];

export const respondRules = [
  token(),
  // strict: only JSON true/false. The string "false" is refused (it would be truthy).
  body('interested').isBoolean({ strict: true }).withMessage('interested must be true or false'),
  validate,
];

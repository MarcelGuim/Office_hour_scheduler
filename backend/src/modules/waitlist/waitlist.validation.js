// Request-shape rules for the waitlist.

import { body, param } from 'express-validator';
import { validate } from '../../validation.js';

export const joinRules = [
  body('officeHourIds')
    .isArray({ min: 1, max: 20 })
    .withMessage('officeHourIds must list 1 to 20 office hours')
    .bail()
    .custom((ids) => new Set(ids).size === ids.length)
    .withMessage('officeHourIds must not repeat an office hour'),
  body('officeHourIds.*').isUUID().withMessage('officeHourIds must be UUIDs'),
  validate,
];

export const idParamRules = [param('id').isUUID().withMessage('id must be a UUID'), validate];

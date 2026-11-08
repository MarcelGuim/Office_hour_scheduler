// Request-shape rules for office hours and bookings.

import { body, param, query } from 'express-validator';
import { validate } from '../../validation.js';

// ISO 8601 with an explicit zone (Z or +hh:mm). Without one, PostgreSQL would guess
// the zone, and the API promises UTC.
const WITH_ZONE = /(Z|[+-]\d{2}:\d{2})$/;
const timestamp = (chain, field) =>
  chain
    .isISO8601({ strict: true, strictSeparator: true })
    .withMessage(`${field} must be an ISO 8601 time, e.g. 2026-11-12T15:00:00Z`)
    .bail()
    .matches(WITH_ZONE)
    .withMessage(`${field} must include a time zone (Z or +hh:mm)`);

export const createSlotRules = [
  body('courseId').isUUID().withMessage('courseId must be a UUID'),
  timestamp(body('startsAt'), 'startsAt'),
  timestamp(body('endsAt'), 'endsAt')
    .bail()
    .custom((endsAt, { req }) => new Date(endsAt) > new Date(req.body.startsAt))
    .withMessage('endsAt must be after startsAt'),
  body('location')
    .isString()
    .withMessage('location is required')
    .bail()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('location must be 1 to 200 characters'),
  validate,
];

export const listSlotsRules = [
  query('courseId').optional().isUUID().withMessage('courseId must be a UUID'),
  timestamp(query('from').optional(), 'from'),
  timestamp(query('to').optional(), 'to'),
  validate,
];

export const idParamRules = [param('id').isUUID().withMessage('id must be a UUID'), validate];

export const bookRules = [body('officeHourId').isUUID().withMessage('officeHourId must be a UUID'), validate];

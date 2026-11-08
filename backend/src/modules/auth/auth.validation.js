// Request-shape rules for the auth endpoints. Each list ends with `validate`, which
// answers 400 {"error": "..."} with the first failed rule.

import { body } from 'express-validator';
import { validate } from '../../validation.js';

const email = () =>
  body('email')
    .isString()
    .withMessage('email is required')
    .bail()
    .trim()
    .isEmail()
    .withMessage('email is not valid')
    .isLength({ max: 254 })
    .withMessage('email is too long');

export const registerRules = [
  body('name')
    .isString()
    .withMessage('name is required')
    .bail()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('name must be 1 to 100 characters'),
  email(),
  body('password')
    .isString()
    .withMessage('password is required')
    .bail()
    .isLength({ min: 8 })
    .withMessage('password must be at least 8 characters')
    // bcrypt only uses the first 72 bytes; longer passwords would be silently cut.
    .custom((value) => Buffer.byteLength(value, 'utf8') <= 72)
    .withMessage('password must be at most 72 bytes'),
  validate,
];

export const loginRules = [
  email(),
  body('password').isString().withMessage('password is required').bail().notEmpty().withMessage('password is required'),
  validate,
];

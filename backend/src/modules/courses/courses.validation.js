// Request-shape rules for the courses endpoints.

import { body, param, query } from 'express-validator';
import { validate } from '../../validation.js';

export const createCourseRules = [
  body('code')
    .isString()
    .withMessage('code is required')
    .bail()
    .trim()
    .toUpperCase() // "ece1779" and "ECE1779" are the same course
    .matches(/^[A-Z0-9-]{2,20}$/)
    .withMessage('code must be 2 to 20 letters, digits or hyphens, e.g. ECE1779'),
  body('name')
    .isString()
    .withMessage('name is required')
    .bail()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('name must be 1 to 200 characters'),
  validate,
];

export const browseCoursesRules = [
  query('search')
    .optional()
    .isString()
    .withMessage('search must be text')
    .bail()
    .trim()
    .isLength({ max: 100 })
    .withMessage('search must be at most 100 characters'),
  validate,
];

export const enrollRules = [
  body('courseId').isUUID().withMessage('courseId must be a UUID'),
  validate,
];

export const enrollmentIdRules = [param('id').isUUID().withMessage('id must be a UUID'), validate];

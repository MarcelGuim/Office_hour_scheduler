// Courses controller. req.user comes from requireRole / requireAuth in the routes file.

import { matchedData } from 'express-validator';
import * as service from './courses.services.js';

export async function createCourse(req, res) {
  const { code, name } = req.body;
  const course = await service.createCourse({ code, name, professorId: req.user.id });
  return res.status(201).json(course);
}

export async function listMyCourses(req, res) {
  return res.status(200).json(await service.listMyCourses(req.user.id));
}

// Query values are read with matchedData: in Express 5 req.query is read-only, so the
// validator's trim() does not change req.query itself, only the matched copy.
export async function browseCourses(req, res) {
  const { search } = matchedData(req, { locations: ['query'] });
  return res.status(200).json(await service.browseCourses(search || undefined));
}

export async function enroll(req, res) {
  const enrollment = await service.enroll({ studentId: req.user.id, courseId: req.body.courseId });
  return res.status(201).json(enrollment);
}

export async function listMyEnrollments(req, res) {
  return res.status(200).json(await service.listMyEnrollments(req.user.id));
}

export async function dropCourse(req, res) {
  const { id } = matchedData(req, { locations: ['params'] });
  await service.dropCourse({ studentId: req.user.id, enrollmentId: id });
  return res.status(204).end();
}

// Office hours and bookings controller. Path and query values come from matchedData
// (Express 5: req.params and req.query are read-only, see src/validation.js).

import { matchedData } from 'express-validator';
import * as service from './officeHours.services.js';

const fromQuery = (req) => matchedData(req, { locations: ['query'] });
const idParam = (req) => matchedData(req, { locations: ['params'] }).id;

// ---- professor ----

export async function createSlot(req, res) {
  const { courseId, startsAt, endsAt, location } = req.body;
  const slot = await service.createSlot({ professorId: req.user.id, courseId, startsAt, endsAt, location });
  return res.status(201).json(slot);
}

export async function listProfessorSlots(req, res) {
  const { courseId, from, to } = fromQuery(req);
  return res.status(200).json(await service.listProfessorSlots({ professorId: req.user.id, courseId, from, to }));
}

export async function getProfessorSlot(req, res) {
  return res.status(200).json(await service.getProfessorSlot({ professorId: req.user.id, slotId: idParam(req) }));
}

export async function cancelSlot(req, res) {
  await service.cancelSlot({ professorId: req.user.id, slotId: idParam(req) });
  return res.status(204).end();
}

// ---- student ----

export async function listStudentSlots(req, res) {
  const { courseId, from, to } = fromQuery(req);
  return res.status(200).json(await service.listStudentSlots({ studentId: req.user.id, courseId, from, to }));
}

export async function book(req, res) {
  const booking = await service.book({ studentId: req.user.id, slotId: req.body.officeHourId });
  return res.status(201).json(booking);
}

export async function listBookings(req, res) {
  return res.status(200).json(await service.listStudentBookings(req.user.id));
}

export async function cancelBooking(req, res) {
  await service.cancelBooking({ studentId: req.user.id, slotId: idParam(req) });
  return res.status(204).end();
}

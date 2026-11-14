// A tiny JSON-file database. Perfect for a hackathon demo: no setup, data lives in
// read-assist/data/db.json and you can open it in any editor. (Swap for Postgres later.)
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ClassDigest, Course, Enrollment, Reading, Session, User } from "./types";
import { countWords, toParagraphs } from "./text";
import { SAMPLE_TEXT, SAMPLE_TITLE } from "./sample";

interface DbShape {
  users: User[];
  courses: Course[];
  enrollments: Enrollment[];
  readings: Reading[];
  sessions: Session[];
  digests: ClassDigest[];
}

const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function makeJoinCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = randomBytes(6);
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return code;
}

function seed(): DbShape {
  const now = new Date().toISOString();
  const prof: User = {
    id: "user_demo_prof",
    name: "Prof. Rivera",
    email: "prof@demo.edu",
    role: "professor",
    createdAt: now,
  };
  const course: Course = {
    id: "course_demo",
    name: "Cognitive Science of Learning",
    code: "PSYC 214",
    term: "Fall 2026",
    professorId: prof.id,
    joinCode: "READ01",
    createdAt: now,
  };
  const paragraphs = toParagraphs(SAMPLE_TEXT);
  // Due in 5 days, stored as noon UTC on that calendar day (see formatDueDate).
  const due = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10) + "T12:00:00.000Z";
  const reading: Reading = {
    id: "reading_demo",
    title: SAMPLE_TITLE,
    paragraphs,
    wordCount: countWords(paragraphs),
    ownerId: prof.id,
    courseId: course.id,
    dueDate: due,
    instructions: "Read before Thursday's lecture on attention. Focus on regressions and return sweeps.",
    source: "sample",
    createdAt: now,
  };
  return { users: [prof], courses: [course], enrollments: [], readings: [reading], sessions: [], digests: [] };
}

// Keep one copy in memory across hot reloads in development.
const g = globalThis as unknown as { __readAssistDb?: DbShape };

function load(): DbShape {
  if (g.__readAssistDb) return g.__readAssistDb;
  let data: DbShape;
  if (existsSync(DB_FILE)) {
    data = JSON.parse(readFileSync(DB_FILE, "utf8")) as DbShape;
    data.digests ??= [];
  } else {
    data = seed();
    persist(data);
  }
  g.__readAssistDb = data;
  return data;
}

function persist(data: DbShape) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, DB_FILE);
}

function save() {
  persist(load());
}

// ---------- Users ----------
export function getUser(id: string | undefined | null): User | null {
  if (!id) return null;
  return load().users.find((u) => u.id === id) ?? null;
}

export function findOrCreateUser(name: string, email: string, role: User["role"]): User {
  const db = load();
  const normalized = email.trim().toLowerCase();
  const existing = db.users.find((u) => u.email === normalized);
  if (existing) return existing;
  const user: User = { id: newId("user"), name: name.trim(), email: normalized, role, createdAt: new Date().toISOString() };
  db.users.push(user);
  // Make the demo feel alive: new students are auto-enrolled in the demo course.
  if (role === "student" && db.courses.some((c) => c.id === "course_demo")) {
    db.enrollments.push({ courseId: "course_demo", userId: user.id, joinedAt: user.createdAt });
  }
  save();
  return user;
}

// ---------- Courses ----------
export function coursesForUser(user: User): Course[] {
  const db = load();
  if (user.role === "professor") return db.courses.filter((c) => c.professorId === user.id);
  const ids = new Set(db.enrollments.filter((e) => e.userId === user.id).map((e) => e.courseId));
  return db.courses.filter((c) => ids.has(c.id));
}

export function getCourse(id: string): Course | null {
  return load().courses.find((c) => c.id === id) ?? null;
}

export function createCourse(professorId: string, name: string, code: string, term: string): Course {
  const db = load();
  const course: Course = {
    id: newId("course"),
    name: name.trim(),
    code: code.trim(),
    term: term.trim(),
    professorId,
    joinCode: makeJoinCode(),
    createdAt: new Date().toISOString(),
  };
  db.courses.push(course);
  save();
  return course;
}

export function joinCourse(userId: string, joinCode: string): Course | null {
  const db = load();
  const course = db.courses.find((c) => c.joinCode === joinCode.trim().toUpperCase());
  if (!course) return null;
  if (!db.enrollments.some((e) => e.courseId === course.id && e.userId === userId)) {
    db.enrollments.push({ courseId: course.id, userId, joinedAt: new Date().toISOString() });
    save();
  }
  return course;
}

export function isEnrolled(userId: string, courseId: string): boolean {
  return load().enrollments.some((e) => e.userId === userId && e.courseId === courseId);
}

export function studentsInCourse(courseId: string): User[] {
  const db = load();
  const ids = new Set(db.enrollments.filter((e) => e.courseId === courseId).map((e) => e.userId));
  return db.users.filter((u) => ids.has(u.id));
}

/** Can this user see this course at all? */
export function canViewCourse(user: User, course: Course): boolean {
  return course.professorId === user.id || isEnrolled(user.id, course.id);
}

// ---------- Readings ----------
export function getReading(id: string): Reading | null {
  return load().readings.find((r) => r.id === id) ?? null;
}

export function readingsForCourse(courseId: string): Reading[] {
  return load()
    .readings.filter((r) => r.courseId === courseId)
    .sort((a, b) => (a.dueDate ?? "9").localeCompare(b.dueDate ?? "9"));
}

export function personalReadings(userId: string): Reading[] {
  return load()
    .readings.filter((r) => r.ownerId === userId && r.courseId === null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function canViewReading(user: User, reading: Reading): boolean {
  if (reading.ownerId === user.id) return true;
  if (!reading.courseId) return false;
  const course = getCourse(reading.courseId);
  return !!course && canViewCourse(user, course);
}

export function createReading(input: Omit<Reading, "id" | "createdAt" | "wordCount">): Reading {
  const db = load();
  const reading: Reading = {
    ...input,
    id: newId("reading"),
    wordCount: countWords(input.paragraphs),
    createdAt: new Date().toISOString(),
  };
  db.readings.push(reading);
  save();
  return reading;
}

// ---------- Sessions ----------
export function createSession(input: Omit<Session, "id">): Session {
  const db = load();
  const session: Session = { ...input, id: newId("session") };
  db.sessions.push(session);
  save();
  return session;
}

export function saveRecall(sessionId: string, section: number, text: string): Session | null {
  const session = load().sessions.find((s) => s.id === sessionId);
  if (!session) return null;
  session.recall ??= {};
  if (text.trim()) session.recall[String(section)] = { text: text.trim(), savedAt: new Date().toISOString() };
  else delete session.recall[String(section)];
  if (Object.keys(session.recall).length === 0) delete session.recall;
  save();
  return session;
}

export function getSession(id: string): Session | null {
  return load().sessions.find((s) => s.id === id) ?? null;
}

export function sessionsFor(userId: string, readingId?: string): Session[] {
  return load()
    .sessions.filter((s) => s.userId === userId && (!readingId || s.readingId === readingId))
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt));
}

export function sessionsForReading(readingId: string): Session[] {
  return load().sessions.filter((s) => s.readingId === readingId);
}

// ---------- Class digests (professor AI summaries) ----------
export function getDigest(readingId: string): ClassDigest | null {
  return load().digests.find((d) => d.readingId === readingId) ?? null;
}

export function saveDigest(digest: ClassDigest) {
  const db = load();
  db.digests = db.digests.filter((d) => d.readingId !== digest.readingId);
  db.digests.push(digest);
  save();
}

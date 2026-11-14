// The database. It's SQLite (via libSQL), so:
//   • on your laptop it's a single file: read-assist/data/read-assist.db (no setup)
//   • when the site is hosted, set DATABASE_URL (+ DATABASE_AUTH_TOKEN) to a free Turso
//     database and the exact same code talks to it over the network.
// The first time it starts, anything in the old data/db.json is copied in, so no test data is lost.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createClient, type Client, type InStatement, type Row } from "@libsql/client";
import type { ClassDigest, Course, LessonPlan, Reading, ResumeState, Session, SessionStatus, User } from "./types";
import { countWords, toParagraphs } from "./text";
import { SAMPLE_TEXT, SAMPLE_TITLE } from "./sample";
import { normalizeReport } from "./validate";

const DATA_DIR = path.join(process.cwd(), "data");
const LEGACY_JSON = path.join(DATA_DIR, "db.json");

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function makeJoinCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (const b of randomBytes(6)) code += alphabet[b % alphabet.length];
  return code;
}

// ---------- connection + schema ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
     password_hash TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS courses (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL, term TEXT NOT NULL DEFAULT '',
     professor_id TEXT NOT NULL REFERENCES users(id), join_code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS enrollments (
     course_id TEXT NOT NULL REFERENCES courses(id), user_id TEXT NOT NULL REFERENCES users(id),
     joined_at TEXT NOT NULL, PRIMARY KEY (course_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS readings (
     id TEXT PRIMARY KEY, title TEXT NOT NULL, paragraphs TEXT NOT NULL, word_count INTEGER NOT NULL,
     owner_id TEXT NOT NULL REFERENCES users(id), course_id TEXT REFERENCES courses(id), due_date TEXT,
     instructions TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS readings_course ON readings(course_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY, reading_id TEXT NOT NULL REFERENCES readings(id), user_id TEXT NOT NULL REFERENCES users(id),
     started_at TEXT NOT NULL, ended_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'done', sittings INTEGER NOT NULL DEFAULT 1,
     report TEXT NOT NULL, ai TEXT, recall TEXT, resume TEXT)`,
  `CREATE INDEX IF NOT EXISTS sessions_reading ON sessions(reading_id)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS digests (
     reading_id TEXT PRIMARY KEY REFERENCES readings(id), text TEXT NOT NULL, generated_by TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS lesson_plans (
     reading_id TEXT PRIMARY KEY REFERENCES readings(id), text TEXT NOT NULL, generated_by TEXT NOT NULL,
     created_at TEXT NOT NULL, based_on_sessions INTEGER NOT NULL)`,
];

const g = globalThis as unknown as { __raClient?: Client; __raReady?: Promise<void> };

function client(): Client {
  if (!g.__raClient) {
    const url = process.env.DATABASE_URL;
    if (!url) mkdirSync(DATA_DIR, { recursive: true });
    g.__raClient = createClient({
      url: url || `file:${path.join(DATA_DIR, "read-assist.db")}`,
      authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
    });
  }
  return g.__raClient;
}

async function db(): Promise<Client> {
  g.__raReady ??= init().catch((e) => {
    g.__raReady = undefined; // retry next request
    throw e;
  });
  await g.__raReady;
  return client();
}

async function init() {
  const c = client();
  await c.batch(SCHEMA, "write");
  const { rows } = await c.execute("SELECT COUNT(*) AS n FROM users");
  if (Number(rows[0].n) > 0) return;
  if (existsSync(LEGACY_JSON)) await importLegacyJson(c);
  else await seed(c);
}

// ---------- row mappers ----------
const json = <T>(v: unknown, fallback: T): T => (typeof v === "string" && v ? (JSON.parse(v) as T) : fallback);
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

function toUser(r: Row): User {
  return { id: String(r.id), name: String(r.name), email: String(r.email), role: r.role as User["role"], createdAt: String(r.created_at), demo: !!Number(r.demo) };
}
function toCourse(r: Row): Course {
  return {
    id: String(r.id), name: String(r.name), code: String(r.code), term: String(r.term),
    professorId: String(r.professor_id), joinCode: String(r.join_code), createdAt: String(r.created_at),
  };
}
function toReading(r: Row): Reading {
  return {
    id: String(r.id), title: String(r.title), paragraphs: json<string[]>(r.paragraphs, []), wordCount: Number(r.word_count),
    ownerId: String(r.owner_id), courseId: str(r.course_id), dueDate: str(r.due_date), instructions: String(r.instructions ?? ""),
    source: r.source as Reading["source"], createdAt: String(r.created_at),
  };
}
function toSession(r: Row, withResume = false): Session {
  return {
    id: String(r.id), readingId: String(r.reading_id), userId: String(r.user_id), startedAt: String(r.started_at),
    endedAt: String(r.ended_at), status: (r.status as SessionStatus) ?? "done", sittings: Number(r.sittings ?? 1),
    report: normalizeReport(json<unknown>(r.report, null)), ai: json(r.ai, null), recall: json(r.recall, undefined),
    resume: withResume ? json<ResumeState | null>(r.resume, null) : undefined,
  };
}
// The resume blob can be large (one number per word); only load it when needed.
const SESSION_COLS = "id, reading_id, user_id, started_at, ended_at, status, sittings, report, ai, recall";

// ---------- seed / import ----------
async function seed(c: Client) {
  const now = new Date().toISOString();
  const paragraphs = toParagraphs(SAMPLE_TEXT);
  // Due in 5 days, stored as noon UTC on that calendar day (see formatDueDate).
  const due = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10) + "T12:00:00.000Z";
  await c.batch(
    [
      { sql: "INSERT INTO users (id,name,email,role,demo,created_at) VALUES (?,?,?,?,1,?)", args: ["user_demo_prof", "Prof. Rivera", "prof@demo.edu", "professor", now] },
      { sql: "INSERT INTO users (id,name,email,role,demo,created_at) VALUES (?,?,?,?,1,?)", args: ["user_demo_student", "Sam Student", "student@demo.edu", "student", now] },
      {
        sql: "INSERT INTO courses (id,name,code,term,professor_id,join_code,created_at) VALUES (?,?,?,?,?,?,?)",
        args: ["course_demo", "Cognitive Science of Learning", "PSYC 214", "Fall 2026", "user_demo_prof", "READ01", now],
      },
      { sql: "INSERT INTO enrollments (course_id,user_id,joined_at) VALUES (?,?,?)", args: ["course_demo", "user_demo_student", now] },
      {
        sql: "INSERT INTO readings (id,title,paragraphs,word_count,owner_id,course_id,due_date,instructions,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        args: [
          "reading_demo", SAMPLE_TITLE, JSON.stringify(paragraphs), countWords(paragraphs), "user_demo_prof", "course_demo", due,
          "Read before Thursday's lecture on attention. Focus on regressions and return sweeps.", "sample", now,
        ],
      },
    ],
    "write",
  );
}

interface LegacyDb {
  users: User[];
  courses: Course[];
  enrollments: { courseId: string; userId: string; joinedAt: string }[];
  readings: Reading[];
  sessions: Session[];
  digests?: ClassDigest[];
}

async function importLegacyJson(c: Client) {
  const d = JSON.parse(readFileSync(LEGACY_JSON, "utf8")) as LegacyDb;
  const stmts: InStatement[] = [];
  // Accounts from the old demo had no passwords, so they stay one-click "demo" accounts.
  for (const u of d.users)
    stmts.push({ sql: "INSERT INTO users (id,name,email,role,demo,created_at) VALUES (?,?,?,?,1,?)", args: [u.id, u.name, u.email, u.role, u.createdAt] });
  if (!d.users.some((u) => u.email === "student@demo.edu")) {
    stmts.push({
      sql: "INSERT INTO users (id,name,email,role,demo,created_at) VALUES (?,?,?,?,1,?)",
      args: ["user_demo_student", "Sam Student", "student@demo.edu", "student", new Date().toISOString()],
    });
  }
  for (const x of d.courses)
    stmts.push({
      sql: "INSERT INTO courses (id,name,code,term,professor_id,join_code,created_at) VALUES (?,?,?,?,?,?,?)",
      args: [x.id, x.name, x.code, x.term, x.professorId, x.joinCode, x.createdAt],
    });
  if (!d.users.some((u) => u.email === "student@demo.edu") && d.courses.some((x) => x.id === "course_demo"))
    stmts.push({ sql: "INSERT OR IGNORE INTO enrollments (course_id,user_id,joined_at) VALUES ('course_demo','user_demo_student',?)", args: [new Date().toISOString()] });
  for (const e of d.enrollments)
    stmts.push({ sql: "INSERT OR IGNORE INTO enrollments (course_id,user_id,joined_at) VALUES (?,?,?)", args: [e.courseId, e.userId, e.joinedAt] });
  for (const r of d.readings)
    stmts.push({
      sql: "INSERT INTO readings (id,title,paragraphs,word_count,owner_id,course_id,due_date,instructions,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      args: [r.id, r.title, JSON.stringify(r.paragraphs), r.wordCount, r.ownerId, r.courseId, r.dueDate, r.instructions ?? "", r.source, r.createdAt],
    });
  for (const s of d.sessions)
    stmts.push({
      sql: "INSERT INTO sessions (id,reading_id,user_id,started_at,ended_at,status,sittings,report,ai,recall) VALUES (?,?,?,?,?,'done',1,?,?,?)",
      args: [s.id, s.readingId, s.userId, s.startedAt, s.endedAt, JSON.stringify(s.report), s.ai ? JSON.stringify(s.ai) : null, s.recall ? JSON.stringify(s.recall) : null],
    });
  for (const x of d.digests ?? [])
    stmts.push({ sql: "INSERT INTO digests (reading_id,text,generated_by,created_at) VALUES (?,?,?,?)", args: [x.readingId, x.text, x.generatedBy, x.createdAt] });
  await c.batch(stmts, "write");
  console.log(`[db] imported data/db.json: ${d.users.length} users, ${d.courses.length} courses, ${d.readings.length} readings, ${d.sessions.length} sessions`);
}

/** A per-install secret (used to sign login cookies when AUTH_SECRET isn't set). */
export async function getOrCreateSecret(): Promise<string> {
  const c = await db();
  const { rows } = await c.execute("SELECT value FROM meta WHERE key = 'auth_secret'");
  if (rows[0]) return String(rows[0].value);
  const secret = randomBytes(32).toString("hex");
  await c.execute({ sql: "INSERT OR IGNORE INTO meta (key, value) VALUES ('auth_secret', ?)", args: [secret] });
  const again = await c.execute("SELECT value FROM meta WHERE key = 'auth_secret'");
  return String(again.rows[0].value);
}

// ---------- Users ----------
export async function getUser(id: string | undefined | null): Promise<User | null> {
  if (!id) return null;
  const { rows } = await (await db()).execute({ sql: "SELECT * FROM users WHERE id = ?", args: [id] });
  return rows[0] ? toUser(rows[0]) : null;
}

export async function getUserByEmail(email: string): Promise<(User & { passwordHash: string | null }) | null> {
  const { rows } = await (await db()).execute({ sql: "SELECT * FROM users WHERE email = ?", args: [email.trim().toLowerCase()] });
  return rows[0] ? { ...toUser(rows[0]), passwordHash: str(rows[0].password_hash) } : null;
}

export async function createUser(name: string, email: string, role: User["role"], passwordHash: string | null): Promise<User> {
  const user: User = { id: newId("user"), name: name.trim(), email: email.trim().toLowerCase(), role, createdAt: new Date().toISOString(), demo: false };
  await (await db()).execute({
    sql: "INSERT INTO users (id,name,email,role,password_hash,demo,created_at) VALUES (?,?,?,?,?,0,?)",
    args: [user.id, user.name, user.email, user.role, passwordHash, user.createdAt],
  });
  return user;
}

export async function demoUsers(): Promise<User[]> {
  const { rows } = await (await db()).execute("SELECT * FROM users WHERE demo = 1 ORDER BY role, created_at");
  return rows.map(toUser);
}

// ---------- Courses ----------
export async function coursesForUser(user: User): Promise<Course[]> {
  const c = await db();
  const { rows } =
    user.role === "professor"
      ? await c.execute({ sql: "SELECT * FROM courses WHERE professor_id = ? ORDER BY created_at", args: [user.id] })
      : await c.execute({
          sql: "SELECT c.* FROM courses c JOIN enrollments e ON e.course_id = c.id WHERE e.user_id = ? ORDER BY e.joined_at",
          args: [user.id],
        });
  return rows.map(toCourse);
}

export async function getCourse(id: string): Promise<Course | null> {
  const { rows } = await (await db()).execute({ sql: "SELECT * FROM courses WHERE id = ?", args: [id] });
  return rows[0] ? toCourse(rows[0]) : null;
}

export async function createCourse(professorId: string, name: string, code: string, term: string): Promise<Course> {
  const c = await db();
  for (let attempt = 0; ; attempt++) {
    const course: Course = {
      id: newId("course"), name: name.trim(), code: code.trim(), term: term.trim(), professorId,
      joinCode: makeJoinCode(), createdAt: new Date().toISOString(),
    };
    try {
      await c.execute({
        sql: "INSERT INTO courses (id,name,code,term,professor_id,join_code,created_at) VALUES (?,?,?,?,?,?,?)",
        args: [course.id, course.name, course.code, course.term, professorId, course.joinCode, course.createdAt],
      });
      return course;
    } catch (e) {
      if (attempt >= 4) throw e; // join code collision: try another code
    }
  }
}

export async function joinCourse(userId: string, joinCode: string): Promise<Course | null> {
  const c = await db();
  const { rows } = await c.execute({ sql: "SELECT * FROM courses WHERE join_code = ?", args: [joinCode.trim().toUpperCase()] });
  if (!rows[0]) return null;
  const course = toCourse(rows[0]);
  if (course.professorId === userId) return course;
  await c.execute({
    sql: "INSERT OR IGNORE INTO enrollments (course_id,user_id,joined_at) VALUES (?,?,?)",
    args: [course.id, userId, new Date().toISOString()],
  });
  return course;
}

export async function isEnrolled(userId: string, courseId: string): Promise<boolean> {
  const { rows } = await (await db()).execute({ sql: "SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?", args: [userId, courseId] });
  return rows.length > 0;
}

export async function studentsInCourse(courseId: string): Promise<User[]> {
  const { rows } = await (await db()).execute({
    sql: "SELECT u.* FROM users u JOIN enrollments e ON e.user_id = u.id WHERE e.course_id = ? ORDER BY u.name COLLATE NOCASE",
    args: [courseId],
  });
  return rows.map(toUser);
}

export async function studentCounts(courseIds: string[]): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  if (!courseIds.length) return m;
  const { rows } = await (await db()).execute({
    sql: `SELECT course_id, COUNT(*) AS n FROM enrollments WHERE course_id IN (${courseIds.map(() => "?").join(",")}) GROUP BY course_id`,
    args: courseIds,
  });
  for (const r of rows) m.set(String(r.course_id), Number(r.n));
  return m;
}

/** Can this user see this course at all? */
export async function canViewCourse(user: User, course: Course): Promise<boolean> {
  return course.professorId === user.id || (await isEnrolled(user.id, course.id));
}

// ---------- Readings ----------
export async function getReading(id: string): Promise<Reading | null> {
  const { rows } = await (await db()).execute({ sql: "SELECT * FROM readings WHERE id = ?", args: [id] });
  return rows[0] ? toReading(rows[0]) : null;
}

export async function readingsForCourse(courseId: string): Promise<Reading[]> {
  const { rows } = await (await db()).execute({
    sql: "SELECT * FROM readings WHERE course_id = ? ORDER BY COALESCE(due_date, '9'), created_at",
    args: [courseId],
  });
  return rows.map(toReading);
}

export async function readingsForCourses(courseIds: string[]): Promise<Reading[]> {
  if (!courseIds.length) return [];
  const { rows } = await (await db()).execute({
    sql: `SELECT * FROM readings WHERE course_id IN (${courseIds.map(() => "?").join(",")}) ORDER BY COALESCE(due_date, '9'), created_at`,
    args: courseIds,
  });
  return rows.map(toReading);
}

export async function personalReadings(userId: string): Promise<Reading[]> {
  const { rows } = await (await db()).execute({
    sql: "SELECT * FROM readings WHERE owner_id = ? AND course_id IS NULL ORDER BY created_at DESC",
    args: [userId],
  });
  return rows.map(toReading);
}

export async function canViewReading(user: User, reading: Reading): Promise<boolean> {
  if (reading.ownerId === user.id) return true;
  if (!reading.courseId) return false;
  const course = await getCourse(reading.courseId);
  return !!course && (await canViewCourse(user, course));
}

export async function createReading(input: Omit<Reading, "id" | "createdAt" | "wordCount">): Promise<Reading> {
  const reading: Reading = { ...input, id: newId("reading"), wordCount: countWords(input.paragraphs), createdAt: new Date().toISOString() };
  await (await db()).execute({
    sql: "INSERT INTO readings (id,title,paragraphs,word_count,owner_id,course_id,due_date,instructions,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    args: [
      reading.id, reading.title, JSON.stringify(reading.paragraphs), reading.wordCount, reading.ownerId, reading.courseId,
      reading.dueDate, reading.instructions, reading.source, reading.createdAt,
    ],
  });
  return reading;
}

export async function updateReadingDueDate(id: string, dueDate: string | null) {
  await (await db()).execute({ sql: "UPDATE readings SET due_date = ? WHERE id = ?", args: [dueDate, id] });
}

// ---------- Sessions ----------
export async function createSession(input: Omit<Session, "id">): Promise<Session> {
  const session: Session = { ...input, id: newId("session") };
  await (await db()).execute({
    sql: "INSERT INTO sessions (id,reading_id,user_id,started_at,ended_at,status,sittings,report,ai,recall,resume) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    args: [
      session.id, session.readingId, session.userId, session.startedAt, session.endedAt, session.status, session.sittings,
      JSON.stringify(session.report), session.ai ? JSON.stringify(session.ai) : null, null,
      session.resume ? JSON.stringify(session.resume) : null,
    ],
  });
  return session;
}

/** Save progress on an existing session (pause again, or finish it). */
export async function updateSession(
  id: string,
  patch: { endedAt: string; status: SessionStatus; sittings: number; report: Session["report"]; ai: Session["ai"]; resume: ResumeState | null },
) {
  await (await db()).execute({
    sql: "UPDATE sessions SET ended_at = ?, status = ?, sittings = ?, report = ?, ai = ?, resume = ? WHERE id = ?",
    args: [patch.endedAt, patch.status, patch.sittings, JSON.stringify(patch.report), patch.ai ? JSON.stringify(patch.ai) : null, patch.resume ? JSON.stringify(patch.resume) : null, id],
  });
}

export async function saveRecall(sessionId: string, section: number, text: string): Promise<Session | null> {
  const session = await getSession(sessionId);
  if (!session) return null;
  const recall = { ...(session.recall ?? {}) };
  if (text.trim()) recall[String(section)] = { text: text.trim(), savedAt: new Date().toISOString() };
  else delete recall[String(section)];
  session.recall = Object.keys(recall).length ? recall : undefined;
  await (await db()).execute({
    sql: "UPDATE sessions SET recall = ? WHERE id = ?",
    args: [session.recall ? JSON.stringify(session.recall) : null, sessionId],
  });
  return session;
}

export async function getSession(id: string, withResume = false): Promise<Session | null> {
  const { rows } = await (await db()).execute({
    sql: `SELECT ${withResume ? "*" : SESSION_COLS} FROM sessions WHERE id = ?`,
    args: [id],
  });
  return rows[0] ? toSession(rows[0], withResume) : null;
}

/** The student's paused (unfinished) session for a reading, if any, with its resume state. */
export async function pausedSession(userId: string, readingId: string): Promise<Session | null> {
  const { rows } = await (await db()).execute({
    sql: "SELECT * FROM sessions WHERE user_id = ? AND reading_id = ? AND status = 'paused' ORDER BY ended_at DESC LIMIT 1",
    args: [userId, readingId],
  });
  return rows[0] ? toSession(rows[0], true) : null;
}

export async function sessionsFor(userId: string, readingId?: string): Promise<Session[]> {
  const { rows } = await (await db()).execute(
    readingId
      ? { sql: `SELECT ${SESSION_COLS} FROM sessions WHERE user_id = ? AND reading_id = ? ORDER BY ended_at DESC`, args: [userId, readingId] }
      : { sql: `SELECT ${SESSION_COLS} FROM sessions WHERE user_id = ? ORDER BY ended_at DESC`, args: [userId] },
  );
  return rows.map((r) => toSession(r));
}

export async function sessionsForReading(readingId: string): Promise<Session[]> {
  const { rows } = await (await db()).execute({ sql: `SELECT ${SESSION_COLS} FROM sessions WHERE reading_id = ? ORDER BY ended_at DESC`, args: [readingId] });
  return rows.map((r) => toSession(r));
}

export async function sessionsForReadings(readingIds: string[]): Promise<Session[]> {
  if (!readingIds.length) return [];
  const { rows } = await (await db()).execute({
    sql: `SELECT ${SESSION_COLS} FROM sessions WHERE reading_id IN (${readingIds.map(() => "?").join(",")}) ORDER BY ended_at DESC`,
    args: readingIds,
  });
  return rows.map((r) => toSession(r));
}

// ---------- Class digests and lesson plans (professor AI) ----------
export async function getDigest(readingId: string): Promise<ClassDigest | null> {
  const { rows } = await (await db()).execute({ sql: "SELECT * FROM digests WHERE reading_id = ?", args: [readingId] });
  const r = rows[0];
  return r ? { readingId, text: String(r.text), generatedBy: r.generated_by as ClassDigest["generatedBy"], createdAt: String(r.created_at) } : null;
}

export async function saveDigest(d: ClassDigest) {
  await (await db()).execute({
    sql: "INSERT OR REPLACE INTO digests (reading_id,text,generated_by,created_at) VALUES (?,?,?,?)",
    args: [d.readingId, d.text, d.generatedBy, d.createdAt],
  });
}

export async function getLessonPlan(readingId: string): Promise<LessonPlan | null> {
  const { rows } = await (await db()).execute({ sql: "SELECT * FROM lesson_plans WHERE reading_id = ?", args: [readingId] });
  const r = rows[0];
  return r
    ? { readingId, text: String(r.text), generatedBy: r.generated_by as LessonPlan["generatedBy"], createdAt: String(r.created_at), basedOnSessions: Number(r.based_on_sessions) }
    : null;
}

export async function saveLessonPlan(p: LessonPlan) {
  await (await db()).execute({
    sql: "INSERT OR REPLACE INTO lesson_plans (reading_id,text,generated_by,created_at,based_on_sessions) VALUES (?,?,?,?,?)",
    args: [p.readingId, p.text, p.generatedBy, p.createdAt, p.basedOnSessions],
  });
}

/** "Start over" on a reading: any older paused session is closed as it stands. */
export async function closePausedSessions(userId: string, readingId: string) {
  await (await db()).execute({
    sql: "UPDATE sessions SET status = 'done', resume = NULL WHERE user_id = ? AND reading_id = ? AND status = 'paused'",
    args: [userId, readingId],
  });
}

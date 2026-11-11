import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './pool';

export interface User {
  id: number;
  username: string;
  passwordHash: string;
  role: 'owner';
  /** False for view-only accounts: they cannot control the engine or place paper orders. */
  canControl: boolean;
  lastLoginAt: string | null;
}

export interface SessionRecord {
  userId: number;
  username: string;
  csrfToken: string;
  expiresAt: Date;
  /** False for view-only accounts. */
  canControl?: boolean;
}

const hashId = (id: string) => createHash('sha256').update(id).digest('hex');

export class UserRepo {
  constructor(private db: Db) {}

  async findByUsername(username: string): Promise<User | undefined> {
    const r = await this.db.query('SELECT id, username, password_hash, role, can_control, last_login_at FROM users WHERE username = $1', [username.toLowerCase()]);
    const u = r.rows[0];
    return u ? { id: Number(u.id), username: u.username, passwordHash: u.password_hash, role: u.role, canControl: u.can_control !== false && u.can_control !== 0, lastLoginAt: u.last_login_at ? new Date(u.last_login_at).toISOString() : null } : undefined;
  }

  async count(): Promise<number> {
    return Number((await this.db.query('SELECT count(*) AS n FROM users')).rows[0]!.n);
  }

  /** Creates the owner, or replaces the password when the user already exists. */
  /** Creates an account, or resets its password. `canControl: false` makes a view-only account. */
  async upsertOwner(username: string, passwordHash: string, canControl = true): Promise<'created' | 'updated'> {
    const name = username.toLowerCase();
    const existing = await this.findByUsername(name);
    if (existing) {
      await this.db.query('UPDATE users SET password_hash = $1, can_control = $2, updated_at = now() WHERE id = $3', [passwordHash, canControl, existing.id]);
      await this.db.query('DELETE FROM sessions WHERE user_id = $1', [existing.id]); // sign out everywhere
      return 'updated';
    }
    await this.db.query(`INSERT INTO users (username, password_hash, role, can_control) VALUES ($1, $2, 'owner', $3)`, [name, passwordHash, canControl]);
    return 'created';
  }

  async touchLogin(id: number): Promise<void> {
    await this.db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
  }
}

export class SessionRepo {
  constructor(
    private db: Db,
    private ttlMs: number,
    private now: () => Date = () => new Date(),
  ) {}

  /** Returns the raw session id (for the cookie). Only its hash is stored. */
  async create(userId: number, meta: { ip?: string; userAgent?: string } = {}): Promise<{ id: string; csrfToken: string; expiresAt: Date }> {
    const id = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + this.ttlMs);
    await this.db.query('INSERT INTO sessions (id_hash, user_id, csrf_token, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6)', [
      hashId(id),
      userId,
      csrfToken,
      expiresAt.toISOString(),
      meta.ip ?? null,
      meta.userAgent?.slice(0, 300) ?? null,
    ]);
    return { id, csrfToken, expiresAt };
  }

  async get(id: string | undefined): Promise<SessionRecord | undefined> {
    if (!id || id.length > 100) return undefined;
    const r = await this.db.query(
      'SELECT s.user_id, s.csrf_token, s.expires_at, u.username, u.can_control FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = $1',
      [hashId(id)],
    );
    const s = r.rows[0];
    if (!s) return undefined;
    const expiresAt = new Date(s.expires_at);
    if (expiresAt.getTime() <= this.now().getTime()) {
      await this.destroy(id);
      return undefined;
    }
    return { userId: Number(s.user_id), username: s.username, csrfToken: s.csrf_token, expiresAt, canControl: s.can_control !== false && s.can_control !== 0 };
  }

  async destroy(id: string | undefined): Promise<void> {
    if (id) await this.db.query('DELETE FROM sessions WHERE id_hash = $1', [hashId(id)]);
  }

  async purgeExpired(): Promise<void> {
    await this.db.query('DELETE FROM sessions WHERE expires_at <= $1', [this.now().toISOString()]);
  }
}

export class SystemLogRepo {
  constructor(private db: Db) {}
  async write(level: 'info' | 'warn' | 'error', source: string, message: string, data?: Record<string, unknown>): Promise<void> {
    await this.db.query('INSERT INTO system_logs (level, source, message, data) VALUES ($1, $2, $3, $4)', [level, source, message, data ? JSON.stringify(data) : null]);
  }
}

export interface SavedResearch {
  id: number;
  symbol: string;
  name: string | null;
  generatedAt: string;
}

/** Research reports saved per user (the full JSON report). */
export class ResearchRepo {
  constructor(private db: Db) {}

  async save(userId: number, symbol: string, generatedAt: string, report: unknown): Promise<void> {
    await this.db.query('INSERT INTO research_reports (user_id, symbol, generated_at, report) VALUES ($1, $2, $3, $4)', [userId, symbol, generatedAt, JSON.stringify(report)]);
  }

  /** Latest report per symbol, newest first. */
  async recent(userId: number, limit = 12): Promise<SavedResearch[]> {
    const r = await this.db.query('SELECT id, symbol, generated_at, report FROM research_reports WHERE user_id = $1 ORDER BY generated_at DESC LIMIT 200', [userId]);
    const seen = new Set<string>();
    const out: SavedResearch[] = [];
    for (const row of r.rows) {
      if (seen.has(row.symbol)) continue;
      seen.add(row.symbol);
      const rep = typeof row.report === 'string' ? JSON.parse(row.report) : row.report;
      out.push({ id: Number(row.id), symbol: row.symbol, name: rep?.overview?.name ?? null, generatedAt: new Date(row.generated_at).toISOString() });
      if (out.length >= limit) break;
    }
    return out;
  }
}

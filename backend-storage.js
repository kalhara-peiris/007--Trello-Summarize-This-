const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STORE_SCHEMA_VERSION = 2;
const DEFAULT_STORE_PATH = path.join(__dirname, "database", "local-backend-store.json");

function createId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
}

function hashPassword(password, salt) {
  const resolvedSalt = salt || crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(String(password || ""), resolvedSalt, 64).toString("hex");
  return {
    passwordHash: derivedKey,
    passwordSalt: resolvedSalt
  };
}

function verifyPassword(user, password) {
  if (user && user.passwordHash && user.passwordSalt) {
    const hashed = hashPassword(password, user.passwordSalt);
    return crypto.timingSafeEqual(Buffer.from(user.passwordHash, "hex"), Buffer.from(hashed.passwordHash, "hex"));
  }
  return user && user.password === String(password || "");
}

function normalizeUser(user) {
  const base = Object.assign({}, user || {});
  if (!base.id) base.id = createId();
  if (!base.createdAt) base.createdAt = new Date().toISOString();
  base.email = String(base.email || "").trim().toLowerCase();
  base.name = String(base.name || "").trim() || "Unnamed User";
  base.role = base.role === "admin" ? "admin" : "user";
  base.credits = Number.isFinite(Number(base.credits)) ? Number(base.credits) : 0;

  if (!base.passwordHash || !base.passwordSalt) {
    const hashed = hashPassword(base.password || "");
    base.passwordHash = hashed.passwordHash;
    base.passwordSalt = hashed.passwordSalt;
  }

  delete base.password;
  return base;
}

function baseStore() {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    users: [
      normalizeUser({
        id: "seed-user",
        email: "test@example.com",
        password: "correct-password",
        name: "Test User",
        credits: 100,
        role: "user",
        createdAt: "2026-07-01T00:00:00.000Z"
      })
    ],
    sessions: [],
    summaries: [],
    transactions: [],
    events: [],
    reviews: [],
    proxyUsage: {},
    systemAlerts: [],
    settingsHistory: [],
    reports: [],
    backups: [],
    maintenanceWindows: [],
    files: [],
    idempotencyKeys: [],
    rateLimits: {},
    settings: {
      proxyEndpoint: "",
      providerMode: "local",
      trelloKeyConfigured: false
    }
  };
}

function serializeStore(store) {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    users: (store.users || []).map(normalizeUser),
    sessions: (store.sessions || []).slice(0, 500),
    summaries: store.summaries || [],
    transactions: store.transactions || [],
    events: store.events || [],
    reviews: store.reviews || [],
    proxyUsage: store.proxyUsage || {},
    systemAlerts: store.systemAlerts || [],
    settingsHistory: store.settingsHistory || [],
    reports: store.reports || [],
    backups: store.backups || [],
    maintenanceWindows: store.maintenanceWindows || [],
    files: store.files || [],
    idempotencyKeys: store.idempotencyKeys || [],
    rateLimits: store.rateLimits || {},
    settings: store.settings || {
      proxyEndpoint: "",
      providerMode: "local",
      trelloKeyConfigured: false
    }
  };
}

function hydrateStore(raw, storagePath) {
  const next = Object.assign(baseStore(), raw || {});
  next.users = (next.users || []).map(normalizeUser);
  next.sessions = Array.isArray(next.sessions) ? next.sessions.filter(Boolean) : [];
  next.tokens = new Map();
  next.sessions.forEach((session) => {
    if (session && session.token && session.userId && !session.revokedAt) {
      next.tokens.set(session.token, session.userId);
    }
  });
  next.storagePath = storagePath;
  next.persist = function persist() {
    const snapshot = serializeStore(next);
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  };
  return next;
}

function loadStore(storagePath = DEFAULT_STORE_PATH) {
  try {
    if (!fs.existsSync(storagePath)) {
      const created = hydrateStore(baseStore(), storagePath);
      created.persist();
      return created;
    }

    const parsed = JSON.parse(fs.readFileSync(storagePath, "utf8"));
    const store = hydrateStore(parsed, storagePath);
    store.persist();
    return store;
  } catch (_error) {
    const fallback = hydrateStore(baseStore(), storagePath);
    fallback.persist();
    return fallback;
  }
}

function createSession(store, userId, metadata = {}) {
  const token = `st_${crypto.randomBytes(18).toString("base64url")}`;
  const session = {
    id: createId(),
    token,
    userId,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    metadata: {
      userAgent: metadata.userAgent || "",
      ipAddress: metadata.ipAddress || ""
    }
  };
  store.sessions.unshift(session);
  store.sessions = store.sessions.slice(0, 500);
  store.tokens.set(token, userId);
  return token;
}

function revokeSession(store, token) {
  if (!token) return false;
  const session = (store.sessions || []).find((item) => item && item.token === token && !item.revokedAt);
  if (!session) return false;
  session.revokedAt = new Date().toISOString();
  store.tokens.delete(token);
  return true;
}

function touchSession(store, token) {
  const session = (store.sessions || []).find((item) => item && item.token === token && !item.revokedAt);
  if (!session) return null;
  session.lastUsedAt = new Date().toISOString();
  return session;
}

module.exports = {
  DEFAULT_STORE_PATH,
  createId,
  createSession,
  hashPassword,
  loadStore,
  revokeSession,
  touchSession,
  verifyPassword
};

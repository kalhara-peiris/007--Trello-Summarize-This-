const crypto = require("node:crypto");
const { URL } = require("node:url");
const config = require("./backend-config");

function createId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
}

function createStore() {
  return {
    users: [
      {
        id: "seed-user",
        email: "test@example.com",
        password: "correct-password",
        name: "Test User",
        credits: 100,
        role: "user",
        createdAt: "2026-07-01T00:00:00.000Z"
      }
    ],
    tokens: new Map(),
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
    settings: {
      proxyEndpoint: "",
      providerMode: "local",
      trelloKeyConfigured: false
    }
  };
}

function clonePublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    credits: user.credits,
    role: user.role,
    createdAt: user.createdAt
  };
}

function json(res, status, payload, headers) {
  const body = JSON.stringify(payload);
  res.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  }, headers || {}));
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(chunk);
      const size = chunks.reduce((sum, value) => sum + value.length, 0);
      if (size > 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (_error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

function createToken(user) {
  const timestamp = Date.now().toString(36);
  const signature = crypto
    .createHmac("sha256", config.JWT_SECRET || "development-secret")
    .update(`${user.id}:${user.email}:${timestamp}`)
    .digest("hex")
    .slice(0, 24);
  return `st_${Buffer.from(`${user.id}:${timestamp}`).toString("base64url")}.${signature}`;
}

function appendEvent(store, type, payload) {
  store.events.unshift({
    id: createId(),
    type,
    createdAt: new Date().toISOString(),
    payload: payload || {}
  });
  store.events = store.events.slice(0, 250);
}

function appendAlert(store, severity, message, source) {
  store.systemAlerts.unshift({
    id: createId(),
    severity,
    message,
    source: source || "backend",
    acknowledged: false,
    createdAt: new Date().toISOString()
  });
  store.systemAlerts = store.systemAlerts.slice(0, 100);
}

function requireAuth(store, req, res) {
  const token = bearerToken(req);
  const userId = store.tokens.get(token);
  const user = store.users.find((item) => item.id === userId);
  if (!token || !user) {
    json(res, 401, { success: false, error: "Unauthorized" });
    return null;
  }
  return user;
}

function summarizeText(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const short = normalized.slice(0, 180);
  return short.length < normalized.length ? `${short}...` : short;
}

function providerMode(payload) {
  if (payload && payload.proxy && payload.proxy.enabled) return "proxy";
  if (payload && payload.provider && payload.provider.apiKey) return "direct-provider";
  return "local";
}

function providerGuardrails(payload) {
  const mode = providerMode(payload);
  const directConfigured = Boolean(config.OPENAI_API_KEY || config.ANTHROPIC_API_KEY || config.GOOGLE_API_KEY);
  const proxyConfigured = Boolean(config.PROXY_ENDPOINT);
  return {
    mode,
    directConfigured,
    proxyConfigured,
    localFallback: mode === "local",
    valid: !(
      (mode === "proxy" && !proxyConfigured) ||
      (mode === "direct-provider" && !directConfigured)
    )
  };
}

function validateSummarizePayload(payload) {
  const text = String(payload && payload.text || "");
  if (!text.trim()) {
    return "Text is required";
  }
  if (text.trim().length < 50) {
    return "Text too short";
  }
  const mode = providerMode(payload);
  if (mode === "proxy" && payload.provider && payload.provider.apiKey) {
    return "Proxy mode cannot be combined with browser-held provider credentials";
  }
  if (mode === "proxy" && !config.PROXY_ENDPOINT) {
    return "Proxy mode was requested but PROXY_ENDPOINT is not configured on the backend";
  }
  if (mode === "direct-provider" && !(config.OPENAI_API_KEY || config.ANTHROPIC_API_KEY || config.GOOGLE_API_KEY)) {
    return "Direct-provider mode was requested but no backend provider key is configured";
  }
  return "";
}

function adminToken() {
  return crypto
    .createHmac("sha256", config.JWT_SECRET || "development-secret")
    .update(`admin:${config.ADMIN_EMAIL}`)
    .digest("hex");
}

function isAdminAuthorized(req) {
  const header = req.headers.authorization || "";
  return header === `Bearer ${adminToken()}`;
}

function requireAdmin(req, res) {
  if (!isAdminAuthorized(req)) {
    json(res, 401, { success: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

function parsePagination(searchParams) {
  const limit = Math.max(1, Math.min(100, Number(searchParams.get("limit") || 25) || 25));
  const offset = Math.max(0, Number(searchParams.get("offset") || 0) || 0);
  return { limit, offset };
}

function paged(list, limit, offset) {
  return {
    total: list.length,
    limit,
    offset,
    items: list.slice(offset, offset + limit)
  };
}

function route(req, res, store) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${config.HOST}:${config.PORT}`}`);
  const pathname = requestUrl.pathname;

  if (req.method === "GET" && pathname === "/api/health") {
    json(res, 200, {
      status: "ok",
      service: "summarize-this-backend",
      timestamp: new Date().toISOString(),
      readiness: config.backendReadiness(),
      trello: config.powerUpReadiness()
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/readiness") {
    const readiness = config.backendReadiness();
    json(res, readiness.ok ? 200 : 503, {
      status: readiness.ok ? "ready" : "blocked",
      missing: readiness.missing,
      optional: readiness.optional
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/config") {
    json(res, 200, config.publicConfig());
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/register") {
    readBody(req).then((body) => {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const name = String(body.name || "").trim();
      if (!email || !password || !name) {
        json(res, 400, { success: false, error: "Missing required fields" });
        return;
      }
      if (store.users.some((user) => user.email === email)) {
        json(res, 409, { success: false, error: "Email already exists" });
        return;
      }
      const user = {
        id: createId(),
        email,
        password,
        name,
        credits: 10,
        role: "user",
        createdAt: new Date().toISOString()
      };
      store.users.push(user);
      const token = createToken(user);
      store.tokens.set(token, user.id);
      appendEvent(store, "user.registered", { userId: user.id, email });
      json(res, 201, { success: true, user: clonePublicUser(user), token });
    }).catch((error) => json(res, 400, { success: false, error: error.message }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/login") {
    readBody(req).then((body) => {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const user = store.users.find((item) => item.email === email && item.password === password);
      if (!user) {
        json(res, 401, { success: false, error: "Invalid credentials" });
        return;
      }
      const token = createToken(user);
      store.tokens.set(token, user.id);
      appendEvent(store, "user.logged_in", { userId: user.id });
      json(res, 200, { success: true, user: clonePublicUser(user), token });
    }).catch((error) => json(res, 400, { success: false, error: error.message }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/auth/login") {
    readBody(req).then((body) => {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (email !== String(config.ADMIN_EMAIL).trim().toLowerCase() || password !== config.ADMIN_PASSWORD) {
        json(res, 401, { success: false, error: "Invalid admin credentials" });
        return;
      }
      appendEvent(store, "admin.logged_in", { email });
      json(res, 200, {
        success: true,
        token: adminToken(),
        admin: { email: config.ADMIN_EMAIL, role: "admin" }
      });
    }).catch((error) => json(res, 400, { success: false, error: error.message }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/auth/logout") {
    json(res, 200, { success: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/auth/refresh") {
    if (!isAdminAuthorized(req)) {
      json(res, 401, { success: false, error: "Unauthorized" });
      return;
    }
    json(res, 200, {
      success: true,
      token: adminToken(),
      admin: { email: config.ADMIN_EMAIL, role: "admin" }
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/auth/verify") {
    if (!isAdminAuthorized(req)) {
      json(res, 401, { success: false, error: "Unauthorized" });
      return;
    }
    json(res, 200, {
      success: true,
      admin: { email: config.ADMIN_EMAIL, role: "admin" }
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/system/health") {
    if (!requireAdmin(req, res)) return;
    json(res, 200, {
      success: true,
      status: "ok",
      readiness: config.backendReadiness(),
      eventsTracked: store.events.length,
      transactionsTracked: store.transactions.length
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/dashboard/metrics") {
    if (!requireAdmin(req, res)) return;
    json(res, 200, {
      success: true,
      metrics: {
        users: store.users.length,
        transactions: store.transactions.length,
        summaries: store.summaries.length,
        reviews: store.reviews.length,
        events: store.events.length
      }
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/dashboard/realtime") {
    if (!requireAdmin(req, res)) return;
    json(res, 200, {
      success: true,
      realtime: {
        activeTokens: store.tokens.size,
        recentEvents: store.events.slice(0, 10),
        alertsOpen: store.systemAlerts.filter((item) => !item.acknowledged).length
      }
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/user/profile") {
    const user = requireAuth(store, req, res);
    if (!user) return;
    json(res, 200, { success: true, user: clonePublicUser(user) });
    return;
  }

  if (req.method === "GET" && pathname === "/api/user/credits") {
    const user = requireAuth(store, req, res);
    if (!user) return;
    json(res, 200, { success: true, credits: user.credits });
    return;
  }

  if (req.method === "GET" && pathname === "/api/user/activity") {
    const user = requireAuth(store, req, res);
    if (!user) return;
    const activities = store.events
      .filter((event) => !event.payload.userId || event.payload.userId === user.id)
      .slice(0, 20);
    json(res, 200, { success: true, activities });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/users") {
    if (!requireAdmin(req, res)) return;
    const pagination = parsePagination(requestUrl.searchParams);
    const users = store.users.map(clonePublicUser);
    const response = paged(users, pagination.limit, pagination.offset);
    json(res, 200, Object.assign({ success: true, users: response.items }, response));
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/users/stats") {
    if (!requireAdmin(req, res)) return;
    const totalCredits = store.users.reduce((sum, user) => sum + Number(user.credits || 0), 0);
    json(res, 200, {
      success: true,
      stats: {
        totalUsers: store.users.length,
        totalCredits,
        averageCredits: store.users.length ? Number((totalCredits / store.users.length).toFixed(2)) : 0
      }
    });
    return;
  }

  const userDetailMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (req.method === "GET" && userDetailMatch) {
    if (!requireAdmin(req, res)) return;
    const user = store.users.find((item) => item.id === userDetailMatch[1]);
    if (!user) {
      json(res, 404, { success: false, error: "User not found" });
      return;
    }
    json(res, 200, { success: true, user: clonePublicUser(user) });
    return;
  }

  if (req.method === "PUT" && userDetailMatch) {
    if (!requireAdmin(req, res)) return;
    readBody(req).then((body) => {
      const user = store.users.find((item) => item.id === userDetailMatch[1]);
      if (!user) {
        json(res, 404, { success: false, error: "User not found" });
        return;
      }
      ["email", "name", "role"].forEach((field) => {
        if (body[field] !== undefined) {
          user[field] = String(body[field]);
        }
      });
      appendEvent(store, "admin.user_updated", { userId: user.id });
      json(res, 200, { success: true, user: clonePublicUser(user) });
    }).catch((error) => json(res, 400, { success: false, error: error.message }));
    return;
  }

  if (req.method === "DELETE" && userDetailMatch) {
    if (!requireAdmin(req, res)) return;
    const index = store.users.findIndex((item) => item.id === userDetailMatch[1]);
    if (index === -1) {
      json(res, 404, { success: false, error: "User not found" });
      return;
    }
    const removed = store.users.splice(index, 1)[0];
    appendEvent(store, "admin.user_deleted", { userId: removed.id });
    json(res, 200, { success: true, user: clonePublicUser(removed) });
    return;
  }

  const userActivityMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/activity$/);
  if (req.method === "GET" && userActivityMatch) {
    if (!requireAdmin(req, res)) return;
    const userId = userActivityMatch[1];
    const activities = store.events.filter((event) => event.payload && event.payload.userId === userId);
    json(res, 200, { success: true, activities });
    return;
  }

  const userSuspendMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/suspend$/);
  if (req.method === "POST" && userSuspendMatch) {
    if (!requireAdmin(req, res)) return;
    readBody(req).then((body) => {
      const user = store.users.find((item) => item.id === userSuspendMatch[1]);
      if (!user) {
        json(res, 404, { success: false, error: "User not found" });
        return;
      }
      user.suspended = true;
      user.suspensionReason = String(body.reason || "");
      appendEvent(store, "admin.user_suspended", { userId: user.id, reason: user.suspensionReason });
      json(res, 200, { success: true, user: clonePublicUser(user), suspended: true });
    }).catch((error) => json(res, 400, { success: false, error: error.message }));
    return;
  }

  const userUnsuspendMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/unsuspend$/);
  if (req.method === "POST" && userUnsuspendMatch) {
    if (!requireAdmin(req, res)) return;
    const user = store.users.find((item) => item.id === userUnsuspendMatch[1]);
    if (!user) {
      json(res, 404, { success: false, error: "User not found" });
      return;
    }
    user.suspended = false;
    delete user.suspensionReason;
    appendEvent(store, "admin.user_unsuspended", { userId: user.id });
    json(res, 200, { success: true, user: clonePublicUser(user), suspended: false });
    return;
  }

  const userCreditsMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/credits$/);
  if (req.method === "GET" && userCreditsMatch) {
    if (!requireAdmin(req, res)) return;
    const user = store.users.find((item) => item.id === userCreditsMatch[1]);
    if (!user) {
      json(res, 404, { success: false, error: "User not found" });
      return;
    }
    json(res, 200, { success: true, credits: user.credits, user: clonePublicUser(user) });
    return;
  }

  const userCreditAdjustMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/credits\/adjust$/);
  if (req.method === "POST" && userCreditAdjustMatch) {
    if (!requireAdmin(req, res)) return;
    readBody(req).then((body) => {
      const user = store.users.find((item) => item.id === userCreditAdjustMatch[1]);
      if (!user) {
        json(res, 404, { success: false, error: "User not found" });
        return;
      }
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount === 0) {
        json(res, 400, { success: false, error: "A non-zero numeric credit adjustment amount is required" });
        return;
      }
      const before = user.credits;
      user.credits += amount;
      const transaction = {
        id: createId(),
        userId: user.id,
        type: "admin_credit_adjustment",
        credits: amount,
        status: "completed",
        reason: String(body.reason || "manual admin adjustment"),
        createdAt: new Date().toISOString()
      };
      store.transactions.unshift(transaction);
      appendEvent(store, "admin.credits_adjusted", {
        userId: user.id,
        before,
        after: user.credits,
        amount
      });
      json(res, 200, { success: true, user: clonePublicUser(user), transaction });
    }).catch((error) => json(res, 400, { success: false, error: error.message }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/summarize") {
    const user = requireAuth(store, req, res);
    if (!user) return;
    readBody(req).then((body) => {
      const validationError = validateSummarizePayload(body);
      if (validationError) {
        json(res, validationError === "Text too short" || validationError === "Text is required" ? 400 : 422, {
          success: false,
          error: validationError
        });
        return;
      }
      if (user.credits < 5) {
        json(res, 402, { success: false, error: "Insufficient credits" });
        return;
      }
      user.credits -= 5;
      const summary = {
        id: createId(),
        summary: summarizeText(body.text),
        method: body.method || "hybrid",
        providerMode: providerMode(body),
        confidence: 0.65,
        guardrails: providerGuardrails(body),
        creditsUsed: 5,
        createdAt: new Date().toISOString()
      };
      if (summary.providerMode === "proxy") {
        store.proxyUsage[user.id] = (store.proxyUsage[user.id] || 0) + 1;
      }
      store.summaries.unshift(summary);
      store.transactions.unshift({
        id: createId(),
        userId: user.id,
        type: "summary_charge",
        credits: -5,
        createdAt: summary.createdAt
      });
      appendEvent(store, "summary.created", { userId: user.id, summaryId: summary.id, providerMode: summary.providerMode });
      json(res, 200, { success: true, result: summary, user: clonePublicUser(user) });
    }).catch((error) => json(res, 400, { success: false, error: error.message }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/credits/purchase") {
    const user = requireAuth(store, req, res);
    if (!user) return;
    readBody(req).then((body) => {
      const packageType = String(body.package || "");
      const packages = {
        basic: { credits: 100, amount: 9.99 },
        premium: { credits: 500, amount: 39.99 },
        enterprise: { credits: 2000, amount: 149.99 }
      };
      const selected = packages[packageType];
      if (!selected || !body.paymentMethodId) {
        json(res, 400, { success: false, error: "Missing or invalid purchase request" });
        return;
      }
      user.credits += selected.credits;
      const transaction = {
        id: createId(),
        userId: user.id,
        type: "credit_purchase",
        credits: selected.credits,
        amount: selected.amount,
        status: "completed",
        createdAt: new Date().toISOString()
      };
      store.transactions.unshift(transaction);
      appendEvent(store, "credits.purchased", { userId: user.id, transactionId: transaction.id });
      json(res, 200, { success: true, transaction, user: clonePublicUser(user) });
    }).catch((error) => json(res, 400, { success: false, error: error.message }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/webhooks/stripe") {
    const signature = req.headers["stripe-signature"];
    if (!signature) {
      json(res, 400, { success: false, error: "Missing signature" });
      return;
    }
    json(res, config.STRIPE_WEBHOOK_SECRET ? 200 : 202, {
      success: true,
      received: true,
      verified: config.STRIPE_WEBHOOK_SECRET ? signature === config.STRIPE_WEBHOOK_SECRET : false
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/transactions") {
    if (!requireAdmin(req, res)) return;
    const pagination = parsePagination(requestUrl.searchParams);
    const response = paged(store.transactions, pagination.limit, pagination.offset);
    json(res, 200, Object.assign({ success: true, transactions: response.items }, response));
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/credits/transactions") {
    if (!requireAdmin(req, res)) return;
    const creditTransactions = store.transactions.filter((item) => Number(item.credits));
    json(res, 200, { success: true, transactions: creditTransactions });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/credits/stats") {
    if (!requireAdmin(req, res)) return;
    const totalCreditsAdded = store.transactions.reduce((sum, item) => sum + Math.max(0, Number(item.credits || 0)), 0);
    const totalCreditsDeducted = store.transactions.reduce((sum, item) => sum + Math.abs(Math.min(0, Number(item.credits || 0))), 0);
    json(res, 200, {
      success: true,
      stats: {
        totalCreditsAdded,
        totalCreditsDeducted,
        purchaseCount: store.transactions.filter((item) => item.type === "credit_purchase").length
      }
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/credits/bulk-adjust") {
    if (!requireAdmin(req, res)) return;
    readBody(req).then((body) => {
      const adjustments = Array.isArray(body.adjustments) ? body.adjustments : [];
      const results = adjustments.map((item) => {
        const user = store.users.find((candidate) => candidate.id === item.userId);
        if (!user) {
          return { userId: item.userId, success: false, error: "User not found" };
        }
        const amount = Number(item.amount);
        if (!Number.isFinite(amount) || amount === 0) {
          return { userId: item.userId, success: false, error: "Invalid amount" };
        }
        user.credits += amount;
        const transaction = {
          id: createId(),
          userId: user.id,
          type: "admin_bulk_credit_adjustment",
          credits: amount,
          status: "completed",
          reason: String(item.reason || "bulk admin adjustment"),
          createdAt: new Date().toISOString()
        };
        store.transactions.unshift(transaction);
        appendEvent(store, "admin.bulk_credits_adjusted", { userId: user.id, amount });
        return { userId: user.id, success: true, credits: user.credits, transactionId: transaction.id };
      });
      json(res, 200, { success: true, results });
    }).catch((error) => json(res, 400, { success: false, error: error.message }));
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/transactions/stats") {
    if (!requireAdmin(req, res)) return;
    json(res, 200, {
      success: true,
      stats: {
        total: store.transactions.length,
        byType: store.transactions.reduce((counts, item) => {
          counts[item.type] = (counts[item.type] || 0) + 1;
          return counts;
        }, {})
      }
    });
    return;
  }

  const transactionDetailMatch = pathname.match(/^\/api\/admin\/transactions\/([^/]+)$/);
  if (req.method === "GET" && transactionDetailMatch) {
    if (!requireAdmin(req, res)) return;
    const transaction = store.transactions.find((item) => item.id === transactionDetailMatch[1]);
    if (!transaction) {
      json(res, 404, { success: false, error: "Transaction not found" });
      return;
    }
    json(res, 200, { success: true, transaction });
    return;
  }

  const transactionReviewMatch = pathname.match(/^\/api\/admin\/transactions\/([^/]+)\/review$/);
  if (req.method === "POST" && transactionReviewMatch) {
    if (!requireAdmin(req, res)) return;
    readBody(req).then((body) => {
      const transaction = store.transactions.find((item) => item.id === transactionReviewMatch[1]);
      if (!transaction) {
        json(res, 404, { success: false, error: "Transaction not found" });
        return;
      }
      const review = {
        id: createId(),
        transactionId: transaction.id,
        notes: String(body.notes || ""),
        createdAt: new Date().toISOString()
      };
      store.reviews.unshift(review);
      appendEvent(store, "admin.transaction_reviewed", { transactionId: transaction.id });
      json(res, 200, { success: true, review });
    }).catch((error) => json(res, 400, { success: false, error: error.message }));
    return;
  }

  const transactionRefundMatch = pathname.match(/^\/api\/admin\/transactions\/([^/]+)\/refund$/);
  if (req.method === "POST" && transactionRefundMatch) {
    if (!requireAdmin(req, res)) return;
    readBody(req).then((body) => {
      const transaction = store.transactions.find((item) => item.id === transactionRefundMatch[1]);
      if (!transaction) {
        json(res, 404, { success: false, error: "Transaction not found" });
        return;
      }
      if (transaction.refunded) {
        json(res, 409, { success: false, error: "Transaction already refunded" });
        return;
      }
      transaction.refunded = true;
      transaction.refundReason = String(body.reason || "");
      transaction.refundedAt = new Date().toISOString();
      appendEvent(store, "admin.transaction_refunded", { transactionId: transaction.id, reason: transaction.refundReason });
      json(res, 200, { success: true, transaction });
    }).catch((error) => json(res, 400, { success: false, error: error.message }));
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/transactions/fraud-alerts") {
    if (!requireAdmin(req, res)) return;
    const alerts = store.systemAlerts.filter((item) => item.source === "fraud" || item.severity === "high");
    json(res, 200, { success: true, alerts });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/system/servers") {
    if (!requireAdmin(req, res)) return;
    json(res, 200, {
      success: true,
      servers: [
        {
          id: "local-backend",
          host: config.HOST,
          port: config.PORT,
          status: "healthy"
        }
      ]
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/system/logs") {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { success: true, logs: store.events.slice(0, 100) });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/system/performance") {
    if (!requireAdmin(req, res)) return;
    json(res, 200, {
      success: true,
      metrics: {
        activeTokens: store.tokens.size,
        summariesGenerated: store.summaries.length,
        proxyCalls: Object.values(store.proxyUsage).reduce((sum, value) => sum + value, 0)
      }
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/system/alerts") {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { success: true, alerts: store.systemAlerts });
    return;
  }

  const alertAckMatch = pathname.match(/^\/api\/admin\/system\/alerts\/([^/]+)\/acknowledge$/);
  if (req.method === "POST" && alertAckMatch) {
    if (!requireAdmin(req, res)) return;
    const alert = store.systemAlerts.find((item) => item.id === alertAckMatch[1]);
    if (!alert) {
      json(res, 404, { success: false, error: "Alert not found" });
      return;
    }
    alert.acknowledged = true;
    alert.acknowledgedAt = new Date().toISOString();
    json(res, 200, { success: true, alert });
    return;
  }

  const serviceRestartMatch = pathname.match(/^\/api\/admin\/system\/services\/([^/]+)\/restart$/);
  if (req.method === "POST" && serviceRestartMatch) {
    if (!requireAdmin(req, res)) return;
    const serviceName = serviceRestartMatch[1];
    appendEvent(store, "admin.service_restarted", { serviceName });
    json(res, 200, { success: true, service: serviceName, restartedAt: new Date().toISOString() });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/settings") {
    if (!requireAdmin(req, res)) return;
    store.settings.proxyEndpoint = config.PROXY_ENDPOINT;
    store.settings.providerMode = config.PROXY_ENDPOINT ? "proxy" : (config.OPENAI_API_KEY || config.ANTHROPIC_API_KEY || config.GOOGLE_API_KEY) ? "direct-provider" : "local";
    store.settings.trelloKeyConfigured = Boolean(config.TRELLO_APP_KEY);
    json(res, 200, { success: true, settings: store.settings });
    return;
  }

  if (req.method === "PUT" && pathname === "/api/admin/settings") {
    if (!requireAdmin(req, res)) return;
    readBody(req).then((body) => {
      const previous = Object.assign({}, store.settings);
      store.settings = Object.assign({}, store.settings, body || {});
      const entry = {
        id: createId(),
        previous,
        next: store.settings,
        createdAt: new Date().toISOString()
      };
      store.settingsHistory.unshift(entry);
      appendEvent(store, "admin.settings_updated", { settingsHistoryId: entry.id });
      json(res, 200, { success: true, settings: store.settings, historyId: entry.id });
    }).catch((error) => json(res, 400, { success: false, error: error.message }));
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/settings/history") {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { success: true, history: store.settingsHistory });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/settings/export") {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { success: true, exportedAt: new Date().toISOString(), settings: store.settings });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/settings/import") {
    if (!requireAdmin(req, res)) return;
    appendEvent(store, "admin.settings_import_requested", {});
    json(res, 202, { success: true, message: "Multipart settings import is not active in the lightweight local backend." });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/analytics") {
    if (!requireAdmin(req, res)) return;
    json(res, 200, {
      success: true,
      analytics: {
        users: store.users.length,
        summaries: store.summaries.length,
        transactions: store.transactions.length,
        alerts: store.systemAlerts.length
      }
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/analytics/users") {
    if (!requireAdmin(req, res)) return;
    json(res, 200, {
      success: true,
      analytics: store.users.map((user) => ({
        userId: user.id,
        email: user.email,
        credits: user.credits,
        suspended: Boolean(user.suspended)
      }))
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/analytics/revenue") {
    if (!requireAdmin(req, res)) return;
    const completedPurchases = store.transactions.filter((item) => item.type === "credit_purchase" && item.status === "completed");
    json(res, 200, {
      success: true,
      analytics: {
        totalRevenue: completedPurchases.reduce((sum, item) => sum + Number(item.amount || 0), 0),
        purchases: completedPurchases.length
      }
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/analytics/usage") {
    if (!requireAdmin(req, res)) return;
    json(res, 200, {
      success: true,
      analytics: {
        summaries: store.summaries.length,
        proxyUsage: store.proxyUsage,
        eventCount: store.events.length
      }
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/reports/generate") {
    if (!requireAdmin(req, res)) return;
    readBody(req).then((body) => {
      const report = {
        id: createId(),
        type: String(body.type || "generic"),
        parameters: body.parameters || {},
        status: "completed",
        createdAt: new Date().toISOString()
      };
      store.reports.unshift(report);
      appendEvent(store, "admin.report_generated", { reportId: report.id, type: report.type });
      json(res, 200, { success: true, report });
    }).catch((error) => json(res, 400, { success: false, error: error.message }));
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/reports") {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { success: true, reports: store.reports });
    return;
  }

  const reportMatch = pathname.match(/^\/api\/admin\/reports\/([^/]+)$/);
  if (req.method === "DELETE" && reportMatch) {
    if (!requireAdmin(req, res)) return;
    const index = store.reports.findIndex((item) => item.id === reportMatch[1]);
    if (index === -1) {
      json(res, 404, { success: false, error: "Report not found" });
      return;
    }
    const removed = store.reports.splice(index, 1)[0];
    json(res, 200, { success: true, report: removed });
    return;
  }

  const reportDownloadMatch = pathname.match(/^\/api\/admin\/reports\/([^/]+)\/download$/);
  if (req.method === "GET" && reportDownloadMatch) {
    if (!requireAdmin(req, res)) return;
    const report = store.reports.find((item) => item.id === reportDownloadMatch[1]);
    if (!report) {
      json(res, 404, { success: false, error: "Report not found" });
      return;
    }
    json(res, 200, { success: true, report });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/audit/export") {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { success: true, exportedAt: new Date().toISOString(), events: store.events, reviews: store.reviews });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/backup/create") {
    if (!requireAdmin(req, res)) return;
    readBody(req).then((body) => {
      const backup = {
        id: createId(),
        type: String(body.type || "full"),
        status: "completed",
        createdAt: new Date().toISOString()
      };
      store.backups.unshift(backup);
      appendEvent(store, "admin.backup_created", { backupId: backup.id });
      json(res, 200, { success: true, backup });
    }).catch((error) => json(res, 400, { success: false, error: error.message }));
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/backup/list") {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { success: true, backups: store.backups });
    return;
  }

  const backupMatch = pathname.match(/^\/api\/admin\/backup\/([^/]+)$/);
  if (req.method === "DELETE" && backupMatch) {
    if (!requireAdmin(req, res)) return;
    const index = store.backups.findIndex((item) => item.id === backupMatch[1]);
    if (index === -1) {
      json(res, 404, { success: false, error: "Backup not found" });
      return;
    }
    const removed = store.backups.splice(index, 1)[0];
    json(res, 200, { success: true, backup: removed });
    return;
  }

  const backupRestoreMatch = pathname.match(/^\/api\/admin\/backup\/([^/]+)\/restore$/);
  if (req.method === "POST" && backupRestoreMatch) {
    if (!requireAdmin(req, res)) return;
    const backup = store.backups.find((item) => item.id === backupRestoreMatch[1]);
    if (!backup) {
      json(res, 404, { success: false, error: "Backup not found" });
      return;
    }
    backup.restoredAt = new Date().toISOString();
    appendEvent(store, "admin.backup_restored", { backupId: backup.id });
    json(res, 200, { success: true, backup });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/maintenance/schedule") {
    if (!requireAdmin(req, res)) return;
    readBody(req).then((body) => {
      const windowRecord = {
        id: createId(),
        startsAt: body.startsAt || null,
        endsAt: body.endsAt || null,
        note: String(body.note || ""),
        createdAt: new Date().toISOString()
      };
      store.maintenanceWindows.unshift(windowRecord);
      appendEvent(store, "admin.maintenance_scheduled", { maintenanceWindowId: windowRecord.id });
      json(res, 200, { success: true, maintenance: windowRecord });
    }).catch((error) => json(res, 400, { success: false, error: error.message }));
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/maintenance/windows") {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { success: true, windows: store.maintenanceWindows });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/files/upload") {
    if (!requireAdmin(req, res)) return;
    const fileRecord = {
      id: createId(),
      status: "accepted",
      createdAt: new Date().toISOString()
    };
    store.files.unshift(fileRecord);
    json(res, 202, { success: true, file: fileRecord, message: "Multipart upload is not active in the lightweight local backend." });
    return;
  }

  const fileMatch = pathname.match(/^\/api\/admin\/files\/([^/]+)$/);
  if (req.method === "DELETE" && fileMatch) {
    if (!requireAdmin(req, res)) return;
    const index = store.files.findIndex((item) => item.id === fileMatch[1]);
    if (index === -1) {
      json(res, 404, { success: false, error: "File not found" });
      return;
    }
    const removed = store.files.splice(index, 1)[0];
    json(res, 200, { success: true, file: removed });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/audit") {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { success: true, events: store.events.slice(0, 100), reviews: store.reviews.slice(0, 100) });
    return;
  }

  text(res, 404, "Not Found");
}

function createBackendApp(options) {
  const store = options && options.store ? options.store : createStore();
  const readiness = config.backendReadiness();
  if (!readiness.ok) {
    readiness.missing.forEach((name) => {
      appendAlert(store, "high", `Required backend environment variable is missing: ${name}`, "startup");
    });
  }
  if (!config.TRELLO_APP_KEY) {
    appendAlert(store, "medium", "TRELLO_APP_KEY is not configured; Trello authorization and signed REST calls cannot complete.", "startup");
  }
  return {
    store,
    handle(req, res) {
      // Security headers
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "no-referrer");

      // CORS for local development
      const origin = req.headers.origin || "*";
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Max-Age", "86400");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      route(req, res, store);
    }
  };
}

module.exports = {
  createBackendApp,
  createStore
};

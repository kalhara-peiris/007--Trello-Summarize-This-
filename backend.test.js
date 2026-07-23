const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin-secret";
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.GOOGLE_API_KEY = "";
process.env.PROXY_ENDPOINT = "";

const { startBackendServer } = require("./backend-server");

async function requestJson(baseUrl, method, path, body, headers = {}) {
  const target = new URL(`${baseUrl}${path}`);
  const payload = body === undefined ? "" : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const request = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers: Object.assign({
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }, headers)
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (_error) {
          data = text;
        }
        resolve({ status: response.statusCode, data });
      });
    });

    request.on("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

async function main() {
  const storagePath = path.join(os.tmpdir(), `summarize-this-backend-${Date.now()}.json`);
  const { server } = await startBackendServer({ host: "127.0.0.1", port: 0, allowMissingEnv: false, storagePath });
  const address = server.address();
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    const health = await requestJson(baseUrl, "GET", "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.data.status, "ok");

    const readiness = await requestJson(baseUrl, "GET", "/api/readiness");
    assert.equal(readiness.status, 200);
    assert.equal(readiness.data.status, "ready");

    const login = await requestJson(baseUrl, "POST", "/api/auth/login", {
      email: "test@example.com",
      password: "correct-password"
    });
    assert.equal(login.status, 200);
    assert.ok(login.data.token);

    const token = login.data.token;
    const profile = await requestJson(baseUrl, "GET", "/api/user/profile", undefined, {
      Authorization: `Bearer ${token}`
    });
    assert.equal(profile.status, 200);
    assert.equal(profile.data.user.email, "test@example.com");
    assert.ok(fs.existsSync(storagePath));

    const logout = await requestJson(baseUrl, "POST", "/api/auth/logout", undefined, {
      Authorization: `Bearer ${token}`
    });
    assert.equal(logout.status, 200);

    const profileAfterLogout = await requestJson(baseUrl, "GET", "/api/user/profile", undefined, {
      Authorization: `Bearer ${token}`
    });
    assert.equal(profileAfterLogout.status, 401);

    const relogin = await requestJson(baseUrl, "POST", "/api/auth/login", {
      email: "test@example.com",
      password: "correct-password"
    }, {
      "Idempotency-Key": "login-replay-test"
    });
    assert.equal(relogin.status, 200);
    assert.ok(relogin.data.token);
    const token2 = relogin.data.token;

    const shortSummary = await requestJson(baseUrl, "POST", "/api/summarize", {
      text: "too short"
    }, {
      Authorization: `Bearer ${token2}`
    });
    assert.equal(shortSummary.status, 400);

    const proxyGuard = await requestJson(baseUrl, "POST", "/api/summarize", {
      text: "This text is definitely long enough to be summarized safely in the backend contract test case.",
      proxy: { enabled: true },
      provider: { apiKey: "browser-key-should-not-pass" }
    }, {
      Authorization: `Bearer ${token2}`
    });
    assert.equal(proxyGuard.status, 422);

    const directModeBlocked = await requestJson(baseUrl, "POST", "/api/summarize", {
      text: "This text is definitely long enough to be summarized safely in the backend contract test case.",
      provider: { apiKey: "browser-key-should-not-pass" }
    }, {
      Authorization: `Bearer ${token2}`
    });
    assert.equal(directModeBlocked.status, 422);

    const summary = await requestJson(baseUrl, "POST", "/api/summarize", {
      text: "This text is definitely long enough to be summarized safely in the backend contract test case.",
      method: "hybrid"
    }, {
      Authorization: `Bearer ${token2}`,
      "Idempotency-Key": "summary-contract-test"
    });
    assert.equal(summary.status, 200);
    assert.equal(summary.data.result.providerMode, "local");

    const summaryReplay = await requestJson(baseUrl, "POST", "/api/summarize", {
      text: "This text is definitely long enough to be summarized safely in the backend contract test case.",
      method: "hybrid"
    }, {
      Authorization: `Bearer ${token2}`,
      "Idempotency-Key": "summary-contract-test"
    });
    assert.equal(summaryReplay.status, 200);
    assert.equal(summaryReplay.data.idempotentReplay, true);

    const credits = await requestJson(baseUrl, "GET", "/api/user/credits", undefined, {
      Authorization: `Bearer ${token2}`
    });
    assert.equal(credits.status, 200);
    assert.equal(typeof credits.data.credits, "number");

    const activity = await requestJson(baseUrl, "GET", "/api/user/activity", undefined, {
      Authorization: `Bearer ${token2}`
    });
    assert.equal(activity.status, 200);
    assert.ok(Array.isArray(activity.data.activities));

    const purchase = await requestJson(baseUrl, "POST", "/api/credits/purchase", {
      package: "basic",
      paymentMethodId: "pm_test"
    }, {
      Authorization: `Bearer ${token2}`
    });
    assert.equal(purchase.status, 200);

    const webhookMissing = await requestJson(baseUrl, "POST", "/api/webhooks/stripe", {});
    assert.equal(webhookMissing.status, 400);

    const webhookSigned = await requestJson(baseUrl, "POST", "/api/webhooks/stripe", {}, {
      "stripe-signature": "test-signature"
    });
    assert.ok(webhookSigned.status === 200 || webhookSigned.status === 202);

    const adminLogin = await requestJson(baseUrl, "POST", "/api/admin/auth/login", {
      email: "admin@example.com",
      password: "admin-secret"
    });
    assert.equal(adminLogin.status, 200);
    assert.ok(adminLogin.data.token);
    const adminToken = adminLogin.data.token;

    const unauthorizedMetrics = await requestJson(baseUrl, "GET", "/api/admin/dashboard/metrics");
    assert.equal(unauthorizedMetrics.status, 401);

    const adminHealth = await requestJson(baseUrl, "GET", "/api/admin/system/health", undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(adminHealth.status, 200);
    assert.equal(adminHealth.data.status, "ok");

    const users = await requestJson(baseUrl, "GET", "/api/admin/users", undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(users.status, 200);
    assert.ok(Array.isArray(users.data.users));

    const userId = users.data.users[0].id;
    const updateUser = await requestJson(baseUrl, "PUT", `/api/admin/users/${userId}`, {
      name: "Updated Test User"
    }, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(updateUser.status, 200);
    assert.equal(updateUser.data.user.name, "Updated Test User");

    const suspendUser = await requestJson(baseUrl, "POST", `/api/admin/users/${userId}/suspend`, {
      reason: "contract test"
    }, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(suspendUser.status, 200);

    const unsuspendUser = await requestJson(baseUrl, "POST", `/api/admin/users/${userId}/unsuspend`, {}, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(unsuspendUser.status, 200);

    const adjustCredits = await requestJson(baseUrl, "POST", `/api/admin/users/${userId}/credits/adjust`, {
      amount: 7,
      reason: "manual test adjustment"
    }, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(adjustCredits.status, 200);
    assert.equal(adjustCredits.data.transaction.type, "admin_credit_adjustment");

    const bulkAdjust = await requestJson(baseUrl, "POST", "/api/admin/credits/bulk-adjust", {
      adjustments: [{ userId, amount: 3, reason: "bulk contract test" }]
    }, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(bulkAdjust.status, 200);
    assert.equal(bulkAdjust.data.results[0].success, true);

    const transactions = await requestJson(baseUrl, "GET", "/api/admin/transactions", undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(transactions.status, 200);
    assert.ok(Array.isArray(transactions.data.transactions));

    const transactionId = transactions.data.transactions[0].id;
    const review = await requestJson(baseUrl, "POST", `/api/admin/transactions/${transactionId}/review`, {
      notes: "Reviewed in contract test"
    }, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(review.status, 200);

    const refund = await requestJson(baseUrl, "POST", `/api/admin/transactions/${transactionId}/refund`, {
      reason: "contract test refund"
    }, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(refund.status, 200);

    const audit = await requestJson(baseUrl, "GET", "/api/admin/audit", undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(audit.status, 200);
    assert.ok(Array.isArray(audit.data.events));
    assert.ok(Array.isArray(audit.data.reviews));

    const settings = await requestJson(baseUrl, "GET", "/api/admin/settings", undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(settings.status, 200);

    const updateSettings = await requestJson(baseUrl, "PUT", "/api/admin/settings", {
      providerMode: "local",
      proxyEndpoint: ""
    }, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(updateSettings.status, 200);

    const settingsHistory = await requestJson(baseUrl, "GET", "/api/admin/settings/history", undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(settingsHistory.status, 200);
    assert.ok(Array.isArray(settingsHistory.data.history));

    const analytics = await requestJson(baseUrl, "GET", "/api/admin/analytics", undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(analytics.status, 200);

    const userAnalytics = await requestJson(baseUrl, "GET", "/api/admin/analytics/users", undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(userAnalytics.status, 200);

    const revenueAnalytics = await requestJson(baseUrl, "GET", "/api/admin/analytics/revenue", undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(revenueAnalytics.status, 200);

    const usageAnalytics = await requestJson(baseUrl, "GET", "/api/admin/analytics/usage", undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(usageAnalytics.status, 200);

    const report = await requestJson(baseUrl, "POST", "/api/admin/reports/generate", {
      type: "usage",
      parameters: { window: "7d" }
    }, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(report.status, 200);
    const reportId = report.data.report.id;

    const reports = await requestJson(baseUrl, "GET", "/api/admin/reports", undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(reports.status, 200);

    const reportDownload = await requestJson(baseUrl, "GET", `/api/admin/reports/${reportId}/download`, undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(reportDownload.status, 200);

    const backup = await requestJson(baseUrl, "POST", "/api/admin/backup/create", {
      type: "full"
    }, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(backup.status, 200);
    const backupId = backup.data.backup.id;

    const backups = await requestJson(baseUrl, "GET", "/api/admin/backup/list", undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(backups.status, 200);

    const restoreBackup = await requestJson(baseUrl, "POST", `/api/admin/backup/${backupId}/restore`, {}, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(restoreBackup.status, 200);

    const maintenance = await requestJson(baseUrl, "POST", "/api/admin/maintenance/schedule", {
      startsAt: "2026-07-20T10:00:00.000Z",
      endsAt: "2026-07-20T11:00:00.000Z",
      note: "contract maintenance"
    }, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(maintenance.status, 200);

    const maintenanceWindows = await requestJson(baseUrl, "GET", "/api/admin/maintenance/windows", undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(maintenanceWindows.status, 200);

    const restartService = await requestJson(baseUrl, "POST", "/api/admin/system/services/api/restart", {}, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(restartService.status, 200);

    const alerts = await requestJson(baseUrl, "GET", "/api/admin/system/alerts", undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(alerts.status, 200);
    assert.ok(Array.isArray(alerts.data.alerts));

    if (alerts.data.alerts.length) {
      const acknowledgeAlert = await requestJson(baseUrl, "POST", `/api/admin/system/alerts/${alerts.data.alerts[0].id}/acknowledge`, {}, {
        Authorization: `Bearer ${adminToken}`
      });
      assert.equal(acknowledgeAlert.status, 200);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(storagePath, { force: true });
  }

  console.log("Backend contract tests passed.");
}
main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

const yahooInstruments = {
  gold: { symbol: "GC=F", instrument: "Gold futures · USD per troy ounce" },
  oil: { symbol: "CL=F", instrument: "WTI crude futures · USD per barrel" },
  sp500: { symbol: "^GSPC", instrument: "S&P 500 index · index points" },
  nasdaq: { symbol: "^IXIC", instrument: "NASDAQ Composite · index points" },
  tesla: { symbol: "TSLA", instrument: "Tesla common stock · USD per share" },
  artificialIntelligence: { symbol: "AIQ", instrument: "Global X AI & Technology ETF · USD per share" },
};

let cachedQuotes = null;
let cachedAt = 0;
let refreshInFlight = null;
let cachedHistory = null;
let historyAt = 0;
let historyInFlight = null;

async function fetchJson(url, yahooRequest = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: yahooRequest
        ? { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; YouInvestMarket/1.0)", referer: "https://finance.yahoo.com/" }
        : { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function yahooQuote(key, asset) {
  const url = "https://query2.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(asset.symbol) + "?range=1d&interval=1m";
  const body = await fetchJson(url, true);
  const result = body?.chart?.result?.[0];
  const meta = result?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  const chartTime = result?.timestamp?.at(-1);
  const marketAt = Number(meta?.regularMarketTime || chartTime) * 1000;
  return {
    price,
    currency: key === "sp500" || key === "nasdaq" ? "" : "USD",
    unit: key === "sp500" || key === "nasdaq" ? "index points" : "",
    instrument: asset.instrument,
    symbol: asset.symbol,
    provider: "Yahoo Finance",
    marketAt: Number.isFinite(marketAt) ? marketAt : Date.now(),
  };
}

async function cryptoQuotes(now) {
  const body = await fetchJson("https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD");
  const result = body?.result;
  if (body?.error?.length || !result) return {};
  const quotes = {};
  for (const [key, ticker, instrument, symbol] of [
    ["bitcoin", "XXBTZUSD", "Bitcoin spot · USD per BTC", "BTC/USD"],
    ["ethereum", "XETHZUSD", "Ethereum spot · USD per ETH", "ETH/USD"],
  ]) {
    const price = Number(result[ticker]?.c?.[0]);
    if (!Number.isFinite(price) || price <= 0) continue;
    quotes[key] = {
      price, currency: "USD", unit: "", instrument, symbol,
      provider: "Kraken", marketAt: now,
    };
  }
  return quotes;
}

async function electricityQuote(now) {
  const start = new Date(now - 72 * 60 * 60 * 1000).toISOString();
  const end = new Date(now).toISOString();
  const params = new URLSearchParams({ bzn: "DE-LU", start, end });
  const body = await fetchJson("https://api.energy-charts.info/price?" + params);
  if (!Array.isArray(body?.unix_seconds) || !Array.isArray(body?.price)) return null;
  let latest = -1;
  for (let i = 0; i < body.unix_seconds.length; i += 1) {
    const timestamp = Number(body.unix_seconds[i]) * 1000;
    const price = Number(body.price[i]);
    if (Number.isFinite(timestamp) && timestamp <= now && Number.isFinite(price) && timestamp > latest) latest = timestamp;
  }
  if (latest < 0) return null;
  const index = body.unix_seconds.findIndex((timestamp) => Number(timestamp) * 1000 === latest);
  return {
    price: Number(body.price[index]),
    currency: "EUR",
    unit: "per MWh",
    instrument: "DE-LU day-ahead electricity · wholesale market",
    symbol: "DE-LU",
    provider: "Energy-Charts · Bundesnetzagentur",
    marketAt: latest,
  };
}


async function yahooHistory(asset) {
  const body = await fetchJson(
    "https://query2.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(asset.symbol) + "?range=1d&interval=1m",
    true,
  );
  const result = body?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const points = timestamps.flatMap((timestamp, index) => {
    const value = Number(closes[index]);
    return Number.isFinite(value) && value > 0
      ? [{ time: Number(timestamp) * 1000, value }]
      : [];
  });
  return points.filter((point, index) => index % 15 === 0 || index === points.length - 1);
}

function electricityHistory(body, since) {
  return (body?.unix_seconds || []).flatMap((seconds, index) => {
    const time = Number(seconds) * 1000;
    const value = Number(body.price[index]);
    return Number.isFinite(time) && time >= since * 1000 && Number.isFinite(value)
      ? [{ time, value }]
      : [];
  });
}

async function loadAssetHistory() {
  const now = Date.now();
  const since = Math.floor((now - 24 * 60 * 60 * 1000) / 1000);
  const electricityParams = new URLSearchParams({
    bzn: "DE-LU",
    start: new Date(now - 72 * 60 * 60 * 1000).toISOString(),
    end: new Date(now).toISOString(),
  });
  const [yahooEntries, bitcoinBody, ethereumBody, bitcoinYahoo, ethereumYahoo, electricityBody] = await Promise.all([
    Promise.all(Object.entries(yahooInstruments).map(async ([key, asset]) => [key, await yahooHistory(asset)])),
    fetchJson("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=30&since=" + since),
    fetchJson("https://api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=30&since=" + since),
    yahooHistory({ symbol: "BTC-USD" }),
    yahooHistory({ symbol: "ETH-USD" }),
    fetchJson("https://api.energy-charts.info/price?" + electricityParams),
  ]);
  const histories = Object.fromEntries(yahooEntries.filter(([, points]) => points.length));
  for (const [key, body, fallback] of [["bitcoin", bitcoinBody, bitcoinYahoo], ["ethereum", ethereumBody, ethereumYahoo]]) {
    const result = body?.result || {};
    const ticker = Object.keys(result).find((name) => name !== "last");
    const points = (ticker ? result[ticker] : []).flatMap((row) => {
      const value = Number(row[4]);
      return Number.isFinite(value) && value > 0 ? [{ time: Number(row[0]) * 1000, value }] : [];
    });
    const fallbackPoints = fallback.filter((point) => Number.isFinite(point.value) && point.value > 0);
    if (points.length) histories[key] = points;
    else if (fallbackPoints.length) histories[key] = fallbackPoints;
  }
  const electricity = electricityHistory(electricityBody, since);
  if (electricity.length) histories.electricity = electricity;
  return { histories, fetchedAt: Date.now() };
}

async function loadQuotes() {
  const now = Date.now();
  const [entries, crypto, electricity] = await Promise.all([
    Promise.all(Object.entries(yahooInstruments).map(async ([key, asset]) => [key, await yahooQuote(key, asset)])),
    cryptoQuotes(now),
    electricityQuote(now),
  ]);
  const quotes = Object.fromEntries(entries.filter(([, quote]) => quote));
  Object.assign(quotes, crypto);
  if (electricity) quotes.electricity = electricity;
  return { quotes, fetchedAt: Date.now() };
}

const websimAccountSchema = "CREATE TABLE IF NOT EXISTS websim_app_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL UNIQUE, username TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('user','admin')), status TEXT NOT NULL DEFAULT 'approved', salt TEXT NOT NULL, password_hash TEXT NOT NULL, account_json TEXT NOT NULL, created_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1); CREATE INDEX IF NOT EXISTS websim_app_accounts_user ON websim_app_accounts(user_id); CREATE UNIQUE INDEX IF NOT EXISTS websim_app_username_lower ON websim_app_accounts(LOWER(username)); CREATE TABLE IF NOT EXISTS websim_app_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES websim_app_accounts(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS websim_app_sessions_account ON websim_app_sessions(account_id); CREATE TABLE IF NOT EXISTS websim_app_recovery (account_id TEXT PRIMARY KEY REFERENCES websim_app_accounts(id) ON DELETE CASCADE, user_id TEXT NOT NULL, recovery_salt TEXT NOT NULL, recovery_hash TEXT NOT NULL, issued_by TEXT NOT NULL, reset_salt TEXT, reset_hash TEXT, reset_expires_at INTEGER)";
export const schema = websimAccountSchema;
const adminEmail = "h9invest@gmail.com";
const accountId = () => crypto.randomUUID();
const hex = (bytes) => [...bytes].map((part) => part.toString(16).padStart(2, "0")).join("");
const safeEqual = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
};
async function appPasswordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 120000, hash: "SHA-256" }, key, 256);
  return hex(new Uint8Array(bits));
}
async function appTokenHash(token) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
}
function baseAppAccount({ id, userId, username, email, role = "user", language = "en" }) {
  return {
    id, username, email, role, status: "approved", createdAt: Date.now(), revision: 1,
    wallet: { deposit: 0, earnings: 0 }, investments: [], transactions: [], depositRequests: [], withdrawalRequests: [],
    preferences: { language, theme: "dark" }, withdrawalWallet: null, walletChangeRequests: [], withdrawalPinSet: false,
    h9Points: 0, bonusSpins: 0, pointHistory: [], referralCode: id.slice(-7).toUpperCase(), referrals: [],
    activeBonuses: [], rewardRedemptions: [], dailyPrizes: [],
  };
}
function appPublicAccount(row) {
  let data = {};
  try { data = JSON.parse(row.account_json || "{}"); } catch {}
  return { ...data, id: row.id, username: row.username, email: row.email, role: row.role, status: row.status, createdAt: Number(row.created_at), revision: Number(row.revision) };
}
function appJson(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
async function appAuth(request, env) {
  const userId = request.headers.get("x-websim-user-id");
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!userId || !token || token.length > 256) return { response: appJson({ error: "Sign in to continue." }, 401) };
  const row = await env.DB.prepare("SELECT a.*, s.expires_at FROM websim_app_sessions s JOIN websim_app_accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? LIMIT 1")
    .bind(await appTokenHash(token), userId, Date.now()).first();
  if (!row) return { response: appJson({ error: "Session expired. Please log in again." }, 401) };
  return { userId, row };
}
async function appStartSession(env, row, userId) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT INTO websim_app_sessions (token_hash,user_id,account_id,expires_at) VALUES (?,?,?,?)")
    .bind(await appTokenHash(token), userId, row.id, Date.now() + 30 * 86400000).run();
  return { token, account: appPublicAccount(row) };
}
async function appAccountApi(request, env, url) {
  if (!url.pathname.startsWith("/api/app/")) return null;
  try {
    const method = request.method;
    const path = url.pathname;
    const userId = request.headers.get("x-websim-user-id");
    const ownerId = request.headers.get("x-websim-project-owner-id");
    const owner = Boolean(userId && ownerId && userId === ownerId);
    const body = ["POST", "PUT", "PATCH"].includes(method) ? await request.json().catch(() => ({})) : {};
    if (path === "/api/app/auth/password-reset/request" && method === "POST") {
      if (!userId) return appJson({ error: "Sign in to WebSIM before resetting a password." }, 401);
      const email = String(body.email || "").trim().toLowerCase();
      const recoveryCode = String(body.recoveryCode || "").replace(/\s/g, "").toUpperCase();
      const row = await env.DB.prepare("SELECT a.id,a.user_id,r.recovery_salt,r.recovery_hash FROM websim_app_accounts a JOIN websim_app_recovery r ON r.account_id=a.id WHERE a.email=? AND a.user_id=? LIMIT 1").bind(email, userId).first();
      if (!row || !safeEqual(await appPasswordHash(recoveryCode, row.recovery_salt), row.recovery_hash)) return appJson({ error: "Email or recovery key is incorrect. Request an admin-issued key from support." }, 401);
      const token = hex(crypto.getRandomValues(new Uint8Array(32)));
      const resetSalt = hex(crypto.getRandomValues(new Uint8Array(16)));
      await env.DB.prepare("UPDATE websim_app_recovery SET reset_salt=?,reset_hash=?,reset_expires_at=? WHERE account_id=?").bind(resetSalt, await appPasswordHash(token, resetSalt), Date.now() + 900000, row.id).run();
      return appJson({ token });
    }
    if (path === "/api/app/auth/password-reset/confirm" && method === "POST") {
      if (!userId) return appJson({ error: "Sign in to WebSIM before resetting a password." }, 401);
      const token = String(body.token || "");
      const password = String(body.password || "");
      if (password.length < 8 || password.length > 200) return appJson({ error: "New password must contain at least 8 characters." }, 400);
      const { results } = await env.DB.prepare("SELECT a.id,r.reset_salt,r.reset_hash,r.reset_expires_at FROM websim_app_accounts a JOIN websim_app_recovery r ON r.account_id=a.id WHERE a.user_id=? AND r.reset_expires_at>?").bind(userId, Date.now()).all();
      let target = null;
      for (const row of results) if (safeEqual(await appPasswordHash(token, row.reset_salt), row.reset_hash)) { target = row; break; }
      if (!target) return appJson({ error: "This password reset has expired or was already used. Verify your recovery key and try again." }, 400);
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      await env.DB.batch([
        env.DB.prepare("UPDATE websim_app_accounts SET salt=?,password_hash=? WHERE id=?").bind(salt, await appPasswordHash(password, salt), target.id),
        env.DB.prepare("DELETE FROM websim_app_sessions WHERE account_id=?").bind(target.id),
        env.DB.prepare("UPDATE websim_app_recovery SET reset_salt=NULL,reset_hash=NULL,reset_expires_at=NULL WHERE account_id=?").bind(target.id),
      ]);
      return appJson({ ok: true });
    }
    if (path === "/api/app/auth/register" && method === "POST") {
      if (!userId) return appJson({ error: "Sign in to WebSIM before creating an account." }, 401);
      const username = String(body.username || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const language = ["en", "fr", "es", "de", "pt", "hi", "zh", "it"].includes(body.language) ? body.language : "en";
      if (username.length < 3 || username.length > 30 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 200) return appJson({ error: "Check your username, email and password (at least 8 characters)." }, 400);
      if (email === adminEmail) return appJson({ error: "This email is reserved." }, 409);
      const id = accountId();
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      const account = baseAppAccount({ id, userId, username, email, language });
      try {
        const result = await env.DB.prepare("INSERT INTO websim_app_accounts (id,user_id,email,username,role,status,salt,password_hash,account_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .bind(id, userId, email, username, "user", "approved", salt, await appPasswordHash(password, salt), JSON.stringify(account), account.createdAt).run();
        if (!result.meta.changes) return appJson({ error: "Email or username is already in use." }, 409);
      } catch {
        return appJson({ error: "Email or username is already in use." }, 409);
      }
      const row = await env.DB.prepare("SELECT * FROM websim_app_accounts WHERE id=?").bind(id).first();
      return appJson(await appStartSession(env, row, userId), 201);
    }
    if (path === "/api/app/auth/login" && method === "POST") {
      if (!userId) return appJson({ error: "Sign in to WebSIM before logging in." }, 401);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!email || !password || password.length > 200) return appJson({ error: "Email or password is incorrect." }, 401);
      let row = await env.DB.prepare("SELECT * FROM websim_app_accounts WHERE email=? LIMIT 1").bind(email).first();
      if (email === adminEmail && password === adminEmail && owner) {
        if (row && (row.role !== "admin" || row.user_id !== userId)) return appJson({ error: "Admin account configuration conflict." }, 503);
        if (!row) {
          const id = accountId();
          const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
          const account = baseAppAccount({ id, userId, username: "Admin-" + id.slice(0, 8), email, role: "admin" });
          await env.DB.prepare("INSERT INTO websim_app_accounts (id,user_id,email,username,role,status,salt,password_hash,account_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
            .bind(id, userId, email, account.username, "admin", "approved", salt, await appPasswordHash(password, salt), JSON.stringify(account), account.createdAt).run();
          row = await env.DB.prepare("SELECT * FROM websim_app_accounts WHERE id=?").bind(id).first();
        } else if (!safeEqual(await appPasswordHash(password, row.salt), row.password_hash)) {
          return appJson({ error: "Email or password is incorrect." }, 401);
        }
      } else if (!row || row.user_id !== userId || row.role === "admin" || !safeEqual(await appPasswordHash(password, row.salt), row.password_hash)) {
        return appJson({ error: "Email or password is incorrect." }, 401);
      }
      if (row.status !== "approved") return appJson({ error: "This account is not active." }, 403);
      return appJson(await appStartSession(env, row, userId));
    }
    if (path === "/api/app/auth/logout" && method === "POST") {
      const auth = await appAuth(request, env);
      if (auth.response) return auth.response;
      const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      await env.DB.prepare("DELETE FROM websim_app_sessions WHERE token_hash=?").bind(await appTokenHash(token)).run();
      return appJson({ ok: true });
    }
    const auth = await appAuth(request, env);
    if (auth.response) return auth.response;
    const ownAccount = appPublicAccount(auth.row);
    if (path === "/api/app/account" && method === "GET") return appJson({ account: ownAccount });
    if (path === "/api/app/auth/password" && method === "PUT") {
      const currentPassword = String(body.currentPassword || "");
      const newPassword = String(body.newPassword || "");
      if (newPassword.length < 8 || newPassword.length > 200 || !safeEqual(await appPasswordHash(currentPassword, auth.row.salt), auth.row.password_hash)) return appJson({ error: "Current password is incorrect or the new password is invalid." }, 400);
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      await env.DB.prepare("UPDATE websim_app_accounts SET salt=?,password_hash=? WHERE id=?").bind(salt, await appPasswordHash(newPassword, salt), auth.row.id).run();
      return appJson({ account: ownAccount });
    }
    if (path === "/api/app/account" && method === "PUT") {
      const incoming = body.account && typeof body.account === "object" ? body.account : body;
      const expectedRevision = Number(body.expectedRevision ?? incoming.revision);
      if (expectedRevision !== Number(auth.row.revision)) return appJson({ error: "Account changed in another browser. Refresh and try again." }, 409);
      const protectedKeys = new Set(["id", "email", "username", "role", "status", "createdAt", "revision", "salt", "passwordHash", "platformAdmin"]);
      const data = JSON.parse(auth.row.account_json || "{}");
      for (const [key, value] of Object.entries(incoming)) if (!protectedKeys.has(key)) data[key] = value;
      const result = await env.DB.prepare("UPDATE websim_app_accounts SET account_json=?,revision=revision+1 WHERE id=? AND revision=?")
        .bind(JSON.stringify(data), auth.row.id, expectedRevision).run();
      if (!result.meta.changes) return appJson({ error: "Account changed in another browser. Refresh and try again." }, 409);
      const updated = await env.DB.prepare("SELECT * FROM websim_app_accounts WHERE id=?").bind(auth.row.id).first();
      return appJson({ account: appPublicAccount(updated) });
    }
    if (path === "/api/app/admin/recovery-key" && method === "POST") {
      if (auth.row.role !== "admin" || !owner) return appJson({ error: "Not authorized." }, 403);
      const email = String(body.email || "").trim().toLowerCase();
      const target = await env.DB.prepare("SELECT * FROM websim_app_accounts WHERE email=? LIMIT 1").bind(email).first();
      if (!target) return appJson({ error: "No registered account was found." }, 404);
      const recoveryCode = hex(crypto.getRandomValues(new Uint8Array(24))).toUpperCase();
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      await env.DB.prepare("INSERT INTO websim_app_recovery (account_id,user_id,recovery_salt,recovery_hash,issued_by) VALUES (?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET user_id=excluded.user_id,recovery_salt=excluded.recovery_salt,recovery_hash=excluded.recovery_hash,issued_by=excluded.issued_by,reset_salt=NULL,reset_hash=NULL,reset_expires_at=NULL")
        .bind(target.id, target.user_id, salt, await appPasswordHash(recoveryCode, salt), auth.row.id).run();
      return appJson({ account: appPublicAccount(target), recoveryCode });
    }
    if (path === "/api/app/admin/accounts" && method === "GET") {
      if (auth.row.role !== "admin" || !owner) return appJson({ error: "Not authorized." }, 403);
      const { results } = await env.DB.prepare("SELECT * FROM websim_app_accounts ORDER BY created_at DESC LIMIT 500").all();
      return appJson({ accounts: results.map(appPublicAccount) });
    }
    if (path === "/api/app/admin/account" && method === "PUT") {
      if (auth.row.role !== "admin" || !owner) return appJson({ error: "Not authorized." }, 403);
      const incoming = body.account && typeof body.account === "object" ? body.account : body;
      const targetId = String(incoming.id || body.id || "");
      const target = await env.DB.prepare("SELECT * FROM websim_app_accounts WHERE id=?").bind(targetId).first();
      if (!target) return appJson({ error: "Account not found." }, 404);
      const expectedRevision = Number(body.expectedRevision ?? incoming.revision);
      if (expectedRevision !== Number(target.revision)) return appJson({ error: "Account changed in another browser. Refresh and try again." }, 409);
      const data = JSON.parse(target.account_json || "{}");
      const protectedKeys = new Set(["id", "email", "username", "role", "status", "createdAt", "revision", "salt", "passwordHash", "platformAdmin"]);
      for (const [key, value] of Object.entries(incoming)) if (!protectedKeys.has(key)) data[key] = value;
      const status = ["approved", "blocked", "pending", "rejected"].includes(incoming.status) ? incoming.status : target.status;
      const result = await env.DB.prepare("UPDATE websim_app_accounts SET account_json=?,status=?,revision=revision+1 WHERE id=? AND revision=?")
        .bind(JSON.stringify(data), status, targetId, expectedRevision).run();
      if (!result.meta.changes) return appJson({ error: "Account changed in another browser. Refresh and try again." }, 409);
      const updated = await env.DB.prepare("SELECT * FROM websim_app_accounts WHERE id=?").bind(targetId).first();
      return appJson({ account: appPublicAccount(updated) });
    }
    if (path === "/api/app/admin/accounts" && method === "DELETE") {
      if (auth.row.role !== "admin" || !owner) return appJson({ error: "Not authorized." }, 403);
      await env.DB.prepare("DELETE FROM websim_app_accounts WHERE role='user'").run();
      return appJson({ ok: true });
    }
    return appJson({ error: "Not found." }, 404);
  } catch (error) {
    console.error("WebSIM account API error:", error?.message || error);
    return appJson({ error: "Service temporarily unavailable." }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const accountResponse = await appAccountApi(request, env, url);
    if (accountResponse) return accountResponse;
    if (request.method !== "GET") return new Response("Not found", { status: 404 });
    if (url.pathname === "/api/asset-history") {
      if (cachedHistory && Date.now() - historyAt < 20_000) {
        return Response.json(cachedHistory, { headers: { "Cache-Control": "no-store" } });
      }
      if (!historyInFlight) {
        historyInFlight = loadAssetHistory().then((data) => {
          cachedHistory = data;
          historyAt = Date.now();
          return cachedHistory;
        }).finally(() => { historyInFlight = null; });
      }
      return Response.json(await historyInFlight, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname !== "/api/asset-prices") return new Response("Not found", { status: 404 });
    if (cachedQuotes && Date.now() - cachedAt < 60_000) {
      return Response.json(cachedQuotes, { headers: { "Cache-Control": "no-store" } });
    }
    if (!refreshInFlight) {
      refreshInFlight = loadQuotes().then((data) => {
        if (Object.keys(data.quotes).length) {
          cachedQuotes = {
            quotes: { ...(cachedQuotes?.quotes || {}), ...data.quotes },
            fetchedAt: data.fetchedAt,
          };
          cachedAt = Date.now();
        }
        return cachedQuotes || data;
      }).finally(() => { refreshInFlight = null; });
    }
    const data = await refreshInFlight;
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  },
};

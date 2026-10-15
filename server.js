import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import axios from 'axios';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const DB_FILE = path.join(__dirname, 'database.json');

let db = {
  accounts: {},
  depositAddresses: {
    bep20: "0x1234567890abcdef1234567890abcdef12345678",
    bitcoin: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
    trc20: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"
  }
};

// Caricamento sicuro del database (senza mai crashare)
try {
  if (fs.existsSync(DB_FILE)) {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(data);
    if (parsed.accounts) db.accounts = parsed.accounts;
    if (parsed.depositAddresses) db.depositAddresses = parsed.depositAddresses;
  } else {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  }
} catch (err) {
  console.error("Avviso DB (continuazione normale):", err.message);
}

function saveDatabase() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error("Errore salvataggio DB:", err);
  }
}

// Configurazione asset Yahoo Finance
const yahooInstruments = {
  gold: { symbol: "GC=F", instrument: "Gold futures" },
  oil: { symbol: "CL=F", instrument: "WTI crude futures" },
  sp500: { symbol: "^GSPC", instrument: "S&P 500 index" },
  nasdaq: { symbol: "^IXIC", instrument: "NASDAQ Composite" },
  tesla: { symbol: "TSLA", instrument: "Tesla stock" }
};

let cachedQuotes = null;
let cachedAt = 0;

async function fetchJson(url, yahooRequest = false) {
  try {
    const response = await axios.get(url, {
      timeout: 5000,
      headers: yahooRequest
        ? { accept: "application/json", "user-agent": "Mozilla/5.0", referer: "https://finance.yahoo.com/" }
        : { accept: "application/json" }
    });
    return response.data;
  } catch {
    return null;
  }
}

// API Prezzi Asset di Mercato
app.get('/api/asset-prices', async (req, res) => {
  try {
    if (cachedQuotes && Date.now() - cachedAt < 60_000) {
      return res.json(cachedQuotes);
    }
    const quotes = {};
    for (const [key, asset] of Object.entries(yahooInstruments)) {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.symbol)}?range=1d&interval=1m`;
      const body = await fetchJson(url, true);
      const meta = body?.chart?.result?.[0]?.meta;
      const price = Number(meta?.regularMarketPrice);
      if (Number.isFinite(price) && price > 0) {
        quotes[key] = { price, currency: "USD", instrument: asset.instrument, symbol: asset.symbol };
      }
    }
    cachedQuotes = { quotes, fetchedAt: Date.now() };
    cachedAt = Date.now();
    res.json(cachedQuotes);
  } catch (err) {
    res.json({ quotes: {} });
  }
});

// Autenticazione e Registrazione
app.post('/api/auth/register', (req, res) => {
  const { username, email, password, language } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Dati mancanti" });

  const cleanEmail = email.toLowerCase().trim();
  if (db.accounts[cleanEmail]) {
    return res.status(400).json({ error: "Account già esistente" });
  }

  const accountId = 'acc_' + Date.now();
  const token = 'token_' + Date.now() + '_' + Math.random().toString(36).substring(2);

  db.accounts[cleanEmail] = {
    id: accountId,
    email: cleanEmail,
    password,
    username: username || "User",
    revision: 1,
    wallet: { deposit: 0, earnings: 0, locked: 0, reinvested: 0 },
    investments: [],
    transactions: [],
    depositRequests: [],
    withdrawalRequests: [],
    preferences: { language: language || 'en', theme: 'dark' },
    withdrawalWallet: null,
    walletChangeRequests: [],
    withdrawalPinSet: false
  };

  saveDatabase();
  res.json({ token, account: db.accounts[cleanEmail] });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(401).json({ error: "Credenziali non valide" });

  const cleanEmail = email.toLowerCase().trim();
  const account = db.accounts[cleanEmail];

  if (!account || account.password !== password) {
    return res.status(401).json({ error: "Email o password errate" });
  }

  const token = 'token_' + Date.now() + '_' + Math.random().toString(36).substring(2);
  res.json({ token, account });
});

app.get('/api/account', (req, res) => {
  const account = Object.values(db.accounts)[0]; 
  if (!account) return res.status(404).json({ error: "Account non trovato" });
  res.json(account);
});

app.get('/api/deposit-addresses', (req, res) => {
  res.json(db.depositAddresses);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server avviato correttamente sulla porta ${PORT}`);
});

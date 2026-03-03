import 'dotenv/config';

/**
 * Honey Pot – Registration Backend
 *
 * Primary storage: Upstash Redis (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).
 * Fallback storage: local JSON file (data/registrations.json) when Redis env vars are absent.
 *
 * The referral link (which contains a private key) is always encrypted with
 * AES-256-GCM before storage, using a key from the ENCRYPTION_KEY env-var.
 *
 * Usage:
 *   ENCRYPTION_KEY=<64 hex chars> \
 *   UPSTASH_REDIS_REST_URL=https://... \
 *   UPSTASH_REDIS_REST_TOKEN=... \
 *   node server.js
 */

import express from 'express';
import cors    from 'cors';
import fs      from 'fs';
import path    from 'path';
import crypto  from 'crypto';
import { fileURLToPath } from 'url';
import { Redis } from '@upstash/redis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Encryption ─────────────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES  = 12;

function loadOrGenerateKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (raw) {
    const buf = Buffer.from(raw.replace(/^0x/, ''), 'hex');
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `ENCRYPTION_KEY must be exactly ${KEY_BYTES * 2} hex characters (${KEY_BYTES} bytes).`
      );
    }
    return buf;
  }
  const generated = crypto.randomBytes(KEY_BYTES);
  console.warn('⚠️  No ENCRYPTION_KEY set. Generated a one-time key for this session:');
  console.warn('   ENCRYPTION_KEY=' + generated.toString('hex'));
  console.warn('   Set this in your environment to persist decryption across restarts.\n');
  return generated;
}

const ENCRYPTION_KEY = loadOrGenerateKey();

function encrypt(plaintext) {
  const iv        = crypto.randomBytes(IV_BYTES);
  const cipher    = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag       = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':');
}

function decrypt(stored) {
  const [ivHex, tagHex, ctHex] = stored.split(':');
  if (!ivHex || !tagHex || !ctHex) throw new Error('Malformed ciphertext record.');
  const iv       = Buffer.from(ivHex,  'hex');
  const tag      = Buffer.from(tagHex, 'hex');
  const ct       = Buffer.from(ctHex,  'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct) + decipher.final('utf8');
}

// ── Storage layer ──────────────────────────────────────────────────────────
// Redis is used when both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
// are set; otherwise falls back to a local JSON file.

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useRedis    = !!(REDIS_URL && REDIS_TOKEN);

let redis = null;
if (useRedis) {
  redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  console.log('💾  Storage: Upstash Redis');
} else {
  console.log('💾  Storage: local JSON file (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to use Redis)');
}

// Redis key prefix so we don't collide with next-auth keys
const REDIS_PREFIX = 'honeypot:registration:';

// ── Local file fallback ────────────────────────────────────────────────────

const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'registrations.json');

function loadLocalStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveLocalStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
}

// ── Unified storage API ────────────────────────────────────────────────────

async function getRegistration(username) {
  if (useRedis) {
    return await redis.get(REDIS_PREFIX + username); // null or object
  }
  const store = loadLocalStore();
  return store[username] ?? null;
}

async function setRegistration(username, entry) {
  if (useRedis) {
    await redis.set(REDIS_PREFIX + username, entry);
  } else {
    const store = loadLocalStore();
    store[username] = entry;
    saveLocalStore(store);
  }
}

async function listRegistrations() {
  if (useRedis) {
    const keys = await redis.keys(REDIS_PREFIX + '*');
    if (!keys.length) return [];
    const values = await Promise.all(keys.map((k) => redis.get(k)));
    return keys.map((k, i) => ({
      username: k.slice(REDIS_PREFIX.length),
      ...values[i],
    }));
  }
  const store = loadLocalStore();
  return Object.entries(store).map(([username, entry]) => ({ username, ...entry }));
}

// ── Express app ────────────────────────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors());
app.use(express.json());

/**
 * POST /api/register
 * Body: { githubUsername, safeAddress, referralLink, txHash? }
 */
app.post('/api/register', async (req, res) => {
  const { githubUsername, safeAddress, referralLink, txHash } = req.body ?? {};

  // ── Validation ────────────────────────────────────────────────────────
  if (!githubUsername || typeof githubUsername !== 'string') {
    return res.status(400).json({ error: 'githubUsername is required.' });
  }
  if (!safeAddress || typeof safeAddress !== 'string') {
    return res.status(400).json({ error: 'safeAddress is required.' });
  }
  if (!referralLink || typeof referralLink !== 'string') {
    return res.status(400).json({ error: 'referralLink is required.' });
  }

  const username = githubUsername.trim().toLowerCase();
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(username)) {
    return res.status(400).json({ error: 'Invalid GitHub username format.' });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(safeAddress)) {
    return res.status(400).json({ error: 'safeAddress must be a valid Ethereum address.' });
  }

  // ── Duplicate check ───────────────────────────────────────────────────
  try {
    const existing = await getRegistration(username);
    if (existing) {
      return res.status(409).json({
        error: `GitHub username "${username}" is already registered.`,
      });
    }
  } catch (err) {
    console.error('Storage read error:', err);
    return res.status(500).json({ error: 'Failed to check existing registration.' });
  }

  // ── Encrypt & persist ─────────────────────────────────────────────────
  let encryptedReferralLink;
  try {
    encryptedReferralLink = encrypt(referralLink.trim());
  } catch (err) {
    console.error('Encryption error:', err);
    return res.status(500).json({ error: 'Failed to encrypt referral link.' });
  }

  const entry = {
    safeAddress,
    encryptedReferralLink,
    ...(txHash && typeof txHash === 'string' ? { txHash } : {}),
    registeredAt: new Date().toISOString(),
  };

  try {
    await setRegistration(username, entry);
  } catch (err) {
    console.error('Storage write error:', err);
    return res.status(500).json({ error: 'Failed to persist registration.' });
  }

  console.log(`✅  Registered: ${username} → ${safeAddress}${txHash ? ` (tx: ${txHash})` : ''}`);
  return res.status(201).json({ ok: true, username });
});

/**
 * GET /api/registration/:username
 * Returns the decrypted referral link for a given GitHub username.
 * In production, protect this with a shared secret or OAuth verification.
 */
app.get('/api/registration/:username', async (req, res) => {
  const username = req.params.username.trim().toLowerCase();

  let entry;
  try {
    entry = await getRegistration(username);
  } catch (err) {
    console.error('Storage read error:', err);
    return res.status(500).json({ error: 'Failed to read registration.' });
  }

  if (!entry) {
    return res.status(404).json({ error: `No registration found for "${username}".` });
  }

  let referralLink;
  try {
    referralLink = decrypt(entry.encryptedReferralLink);
  } catch (err) {
    console.error('Decryption error:', err);
    return res.status(500).json({ error: 'Failed to decrypt referral link.' });
  }

  return res.json({
    username,
    safeAddress: entry.safeAddress,
    referralLink,
    ...(entry.txHash ? { txHash: entry.txHash } : {}),
    registeredAt: entry.registeredAt,
  });
});

/**
 * GET /api/registrations
 * Lists all registrations without decrypting the referral links.
 */
app.get('/api/registrations', async (_req, res) => {
  try {
    const all = await listRegistrations();
    return res.json(
      all.map(({ username, safeAddress, txHash, registeredAt }) => ({
        username,
        safeAddress,
        ...(txHash ? { txHash } : {}),
        registeredAt,
      }))
    );
  } catch (err) {
    console.error('Storage list error:', err);
    return res.status(500).json({ error: 'Failed to list registrations.' });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🍯  Honey Pot server listening on http://localhost:${PORT}`);
});
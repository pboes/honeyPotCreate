import { privateKeyToAddress } from 'viem/accounts';
import { createPublicClient, http } from 'viem';
import { gnosis } from 'viem/chains';
import { onWalletChange, sendTransactions } from '@aboutcircles/miniapp-sdk';

// ── Constants ──────────────────────────────────────────────────────────────
const REGISTRY_CONTRACT  = '0x12105a9B291aF2ABb0591001155A75949b062CE5';
const CRC_TOKEN          = '0x548c20e6c24E4876E20daDbEAb75362e2F5A4bC1';
const REDEMPTION_DOMAIN  = 'https://honey-pot-redeem.vercel.app/'; // TODO: set real domain
const API_BASE           = 'honeypotcreate-production.up.railway.app';

const COMPUTE_ADDRESS_ABI = [
  {
    inputs: [{ name: 'owner', type: 'address' }],
    name: 'computeAddress',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
];

const ERC20_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
];

const publicClient = createPublicClient({
  chain: gnosis,
  transport: http('https://rpc.gnosischain.com'),
});

// ── State ──────────────────────────────────────────────────────────────────
let parsedPrivateKey   = null;
let derivedSafeAddress = null;
let connectedAddress   = null;
let crcBalanceWei      = null; // bigint | null

// ── DOM refs ───────────────────────────────────────────────────────────────
const walletStatusEl      = document.getElementById('wallet-status');

const referralLinkInput   = document.getElementById('referralLink');
const safeAddressEl       = document.getElementById('safeAddress');
const parsedSection       = document.getElementById('parsed-section');
const linkBadge           = document.getElementById('link-badge');
const step1Result         = document.getElementById('step1-result');
const parseBtn            = document.getElementById('parseBtn');
const nextBtn1            = document.getElementById('nextBtn1');

const githubUsernameInput = document.getElementById('githubUsername');
const crcAmountInput      = document.getElementById('crcAmount');
const step2Result         = document.getElementById('step2-result');
const crcBalanceBadge     = document.getElementById('crc-balance-badge');
const maxBtn              = document.getElementById('maxBtn');
const registerBtn         = document.getElementById('registerBtn');
const backBtn1            = document.getElementById('backBtn1');

const redemptionLinkEl    = document.getElementById('redemptionLink');
const summaryUsername     = document.getElementById('summary-username');
const summarySafe         = document.getElementById('summary-safe');
const summaryAmount       = document.getElementById('summary-amount');
const txRow               = document.getElementById('tx-row');
const summaryTx           = document.getElementById('summary-tx');
const copyBtn             = document.getElementById('copyBtn');
const startOverBtn        = document.getElementById('startOverBtn');

// ── Balance fetching ───────────────────────────────────────────────────────
async function fetchAndDisplayBalance(address) {
  crcBalanceBadge.textContent = 'Balance: fetching…';
  crcBalanceWei = null;
  maxBtn.disabled = true;
  try {
    const raw = await publicClient.readContract({
      address: CRC_TOKEN,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address],
    });
    crcBalanceWei = raw; // bigint
    const human = formatCrc(raw);
    crcBalanceBadge.textContent = `Balance: ${human} CRC`;
    crcBalanceBadge.style.color = raw === 0n ? '#b54708' : '#158030';
    maxBtn.disabled = raw === 0n;
  } catch (err) {
    crcBalanceBadge.textContent = 'Balance: error';
    crcBalanceBadge.style.color = '#b91c1c';
    console.error('balanceOf failed:', err);
  }
}

// ── Wallet connection ──────────────────────────────────────────────────────
onWalletChange((address) => {
  connectedAddress = address;
  if (address) {
    walletStatusEl.className = 'status connected';
    walletStatusEl.innerHTML =
      'Connected: <span class="addr">' + address + '</span>';
    fetchAndDisplayBalance(address);
  } else {
    walletStatusEl.className = 'status disconnected';
    walletStatusEl.textContent = 'Waiting for wallet connection…';
    crcBalanceWei = null;
    crcBalanceBadge.textContent = 'Balance: —';
    crcBalanceBadge.style.color = '#6a6c8c';
    maxBtn.disabled = true;
  }
});

// ── Step navigation ────────────────────────────────────────────────────────
function showStep(n) {
  [1, 2, 3].forEach((i) => {
    document.getElementById(`step-${i}`).classList.toggle('visible', i === n);
    const dot = document.getElementById(`dot-${i}`);
    dot.classList.remove('active', 'done');
    if (i < n)  dot.classList.add('done');
    if (i === n) dot.classList.add('active');
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────
function setResult(el, type, msg) {
  el.className = `result ${type} show`;
  el.textContent = msg;
}

function clearResult(el) {
  el.className = 'result';
  el.textContent = '';
}

function shortenAddress(addr) {
  if (!addr || addr.length < 10) return addr;
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function shortenHash(hash) {
  if (!hash || hash.length < 10) return hash;
  return hash.slice(0, 10) + '…' + hash.slice(-6);
}

/**
 * Format a wei bigint as a human-readable CRC string (up to 4 decimal places).
 */
function formatCrc(wei) {
  const whole = wei / BigInt('1000000000000000000');
  const frac  = wei % BigInt('1000000000000000000');
  if (frac === 0n) return whole.toString();
  // Show up to 4 significant fractional digits
  const fracStr = frac.toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

/**
 * Convert a wei bigint to the human-readable string used in the amount input.
 * Uses up to 6 decimal places.
 */
function weiToInputValue(wei) {
  const whole = wei / BigInt('1000000000000000000');
  const frac  = wei % BigInt('1000000000000000000');
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

/**
 * Parse a human-readable CRC amount (e.g. "10" or "2.5") into wei (bigint).
 * CRC uses 18 decimals like most ERC-20 tokens.
 */
function parseCrcToWei(humanAmount) {
  const trimmed = humanAmount.trim();
  if (!trimmed) throw new Error('Please enter an amount of CRC to send.');

  const float = parseFloat(trimmed);
  if (isNaN(float) || float <= 0) {
    throw new Error('Amount must be a positive number.');
  }

  // Split on decimal point to avoid floating-point precision issues
  const [intPart, fracPart = ''] = trimmed.split('.');
  const frac = fracPart.slice(0, 18).padEnd(18, '0'); // truncate beyond 18 dp
  return BigInt(intPart) * BigInt('1000000000000000000') + BigInt(frac);
}

/**
 * Encode ERC-20 transfer(address,uint256) calldata.
 * No external library needed — the selector is fixed.
 */
function encodeErc20Transfer(to, amountWei) {
  const selector  = '0xa9059cbb';
  const paddedTo  = to.toLowerCase().replace('0x', '').padStart(64, '0');
  const paddedAmt = amountWei.toString(16).padStart(64, '0');
  return selector + paddedTo + paddedAmt;
}

/**
 * Extract the private key from a referral link.
 * Supports full URLs or bare hex (with or without 0x prefix).
 */
function extractPrivateKey(raw) {
  const trimmed = raw.trim();
  let candidate = trimmed;
  try {
    const url = new URL(trimmed);
    const segments = url.pathname.split('/').filter(Boolean);
    candidate = segments[segments.length - 1] ?? trimmed;
  } catch {
    // not a URL — use as-is
  }

  if (!candidate.startsWith('0x') && !candidate.startsWith('0X')) {
    candidate = '0x' + candidate;
  }
  candidate = candidate.toLowerCase();

  if (!/^0x[0-9a-f]{64}$/.test(candidate)) {
    throw new Error(
      'Could not find a valid 64-hex-char private key in the link. ' +
      'Expected format: https://app.gnosis.io/referral/0x<64 hex chars>'
    );
  }
  return candidate;
}

// ── Step 1: Parse referral link ────────────────────────────────────────────
parseBtn.addEventListener('click', async () => {
  clearResult(step1Result);
  parsedSection.style.display = 'none';
  parsedPrivateKey   = null;
  derivedSafeAddress = null;
  nextBtn1.disabled  = true;
  linkBadge.textContent = 'Checking…';
  linkBadge.className   = 'badge warn';

  const raw = referralLinkInput.value;
  if (!raw.trim()) {
    setResult(step1Result, 'error', 'Please paste a referral link first.');
    return;
  }

  parseBtn.disabled = true;
  setResult(step1Result, 'pending', 'Parsing link and computing Safe address…');

  try {
    const privateKey    = extractPrivateKey(raw);
    const signerAddress = privateKeyToAddress(privateKey);

    const safeAddr = await publicClient.readContract({
      address: REGISTRY_CONTRACT,
      abi: COMPUTE_ADDRESS_ABI,
      functionName: 'computeAddress',
      args: [signerAddress],
    });

    parsedPrivateKey   = privateKey;
    derivedSafeAddress = safeAddr;

    safeAddressEl.textContent    = safeAddr;
    parsedSection.style.display  = 'block';
    linkBadge.textContent        = 'Valid';
    linkBadge.className          = 'badge ok';
    clearResult(step1Result);
    nextBtn1.disabled = false;
  } catch (err) {
    linkBadge.textContent = 'Invalid';
    linkBadge.className   = 'badge warn';
    setResult(step1Result, 'error', err.message);
    parsedSection.style.display = 'none';
  }

  parseBtn.disabled = false;
});

// Auto-parse on blur
referralLinkInput.addEventListener('blur', () => {
  if (referralLinkInput.value.trim()) parseBtn.click();
});

nextBtn1.addEventListener('click', () => {
  // Refresh balance when entering step 2 in case wallet connected after step 1
  if (connectedAddress) fetchAndDisplayBalance(connectedAddress);
  showStep(2);
});
backBtn1.addEventListener('click', () => showStep(1));

// ── Max button ─────────────────────────────────────────────────────────────
maxBtn.addEventListener('click', () => {
  if (crcBalanceWei !== null && crcBalanceWei > 0n) {
    crcAmountInput.value = weiToInputValue(crcBalanceWei);
  }
});

// ── Step 2: Fund & Register ────────────────────────────────────────────────
registerBtn.addEventListener('click', async () => {
  clearResult(step2Result);

  // ── Validate inputs ──────────────────────────────────────────────────
  if (!connectedAddress) {
    setResult(step2Result, 'error', 'No wallet connected. Please open this app inside the Circles host wallet.');
    return;
  }

  const username = githubUsernameInput.value.trim();
  if (!username) {
    setResult(step2Result, 'error', 'Please enter a GitHub username.');
    return;
  }
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(username)) {
    setResult(step2Result, 'error', "That doesn't look like a valid GitHub username.");
    return;
  }

  let amountWei;
  try {
    amountWei = parseCrcToWei(crcAmountInput.value);
  } catch (err) {
    setResult(step2Result, 'error', err.message);
    return;
  }

  // Pre-flight balance check — saves the user a failed wallet prompt
  if (crcBalanceWei !== null && amountWei > crcBalanceWei) {
    setResult(
      step2Result,
      'error',
      `Insufficient balance: you have ${formatCrc(crcBalanceWei)} CRC but tried to send ${formatCrc(amountWei)} CRC.`
    );
    return;
  }

  if (!parsedPrivateKey || !derivedSafeAddress) {
    setResult(step2Result, 'error', 'Missing parsed link data. Please go back to Step 1.');
    return;
  }

  registerBtn.disabled = true;

  // ── 1. Send ERC-20 transfer ──────────────────────────────────────────
  setResult(step2Result, 'pending', 'Requesting transfer approval from host wallet…');

  let txHashes;
  try {
    const calldata = encodeErc20Transfer(derivedSafeAddress, amountWei);
    txHashes = await sendTransactions([
      { to: CRC_TOKEN, data: calldata, value: '0' },
    ]);
  } catch (err) {
    setResult(step2Result, 'error', 'Transfer failed or was rejected: ' + err.message);
    registerBtn.disabled = false;
    return;
  }

  const txHash = txHashes[0];

  // ── 2. Register with backend ─────────────────────────────────────────
  setResult(step2Result, 'pending', 'Transfer submitted! Registering with backend…');

  try {
    const resp = await fetch(`${API_BASE}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        githubUsername: username,
        safeAddress:    derivedSafeAddress,
        referralLink:   referralLinkInput.value.trim(),
        txHash,
      }),
    });

    const body = await resp.json();
    if (!resp.ok) throw new Error(body.error ?? `Server error ${resp.status}`);
  } catch (err) {
    // Transfer already went through — show a warning, not a hard error
    setResult(
      step2Result,
      'error',
      `Transfer sent (${shortenHash(txHash)}) but registration failed: ${err.message}. ` +
      `You can retry registration without re-sending CRC.`
    );
    registerBtn.disabled = false;
    return;
  }

  // ── 3. Success ───────────────────────────────────────────────────────
  const humanAmount    = parseFloat(crcAmountInput.value).toLocaleString() + ' CRC';
  const redemptionLink = `${REDEMPTION_DOMAIN}/redeem/${encodeURIComponent(username)}`;

  redemptionLinkEl.textContent = redemptionLink;
  summaryUsername.textContent  = username;
  summarySafe.textContent      = shortenAddress(derivedSafeAddress);
  summaryAmount.textContent    = humanAmount;

  if (txHash) {
    txRow.style.display      = 'flex';
    summaryTx.textContent    = shortenHash(txHash);
    summaryTx.href           = `https://gnosisscan.io/tx/${txHash}`;
  }

  showStep(3);
  registerBtn.disabled = false;
});

// ── Step 3: Copy link ──────────────────────────────────────────────────────
copyBtn.addEventListener('click', async () => {
  const link = redemptionLinkEl.textContent;
  try {
    await navigator.clipboard.writeText(link);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => (copyBtn.textContent = 'Copy'), 2000);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = link;
    ta.style.position = 'fixed';
    ta.style.opacity  = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => (copyBtn.textContent = 'Copy'), 2000);
  }
});

// ── Start over ─────────────────────────────────────────────────────────────
startOverBtn.addEventListener('click', () => {
  parsedPrivateKey              = null;
  derivedSafeAddress            = null;
  referralLinkInput.value       = '';
  githubUsernameInput.value     = '';
  crcAmountInput.value          = '';
  crcBalanceBadge.textContent   = 'Balance: —';
  crcBalanceBadge.style.color   = '#6a6c8c';
  crcBalanceWei                 = null;
  maxBtn.disabled               = true;
  safeAddressEl.textContent     = '—';
  parsedSection.style.display   = 'none';
  linkBadge.textContent         = 'Unverified';
  linkBadge.className           = 'badge warn';
  nextBtn1.disabled             = true;
  txRow.style.display           = 'none';
  clearResult(step1Result);
  clearResult(step2Result);
  showStep(1);
});

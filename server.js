#!/usr/bin/env node
"use strict";

/**
 * The Solana Faucet
 * A small 2010-style drip: solve a captcha, paste an address, get 0.01 SOL.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const bs58 = require("bs58");

require("dotenv").config();

const PAYOUT_SOL = 0.01;
const PAYOUT_LAMPORTS = 10_000_000; // exactly 0.01 SOL. never more, never less.
if (PAYOUT_LAMPORTS !== Math.round(PAYOUT_SOL * LAMPORTS_PER_SOL)) {
  throw new Error("payout constant mismatch");
}

const PORT = parseInt(process.env.PORT || "3456", 10);
const RPC_URL = process.env.RPC_URL || "";
const CLAIM_WINDOW_MS = parseInt(process.env.CLAIM_WINDOW_MS || String(24 * 60 * 60 * 1000), 10);
const DATA_DIR = path.join(__dirname, "data");
const CLAIMS_PATH = path.join(DATA_DIR, "claims.json");
const DONATE_PLACEHOLDER = "DqWPN6zptwMsUda2La6rgQSnfNubkhJJhvVvV3zYSNYv";

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(express.urlencoded({ extended: false, limit: "8kb" }));
app.use(
  session({
    name: "faucet.sid",
    secret: process.env.SESSION_SECRET || "solana-faucet-dev-secret",
    resave: false,
    saveUninitialized: true,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 2 * 60 * 60 * 1000 },
  })
);
app.use(express.static(path.join(__dirname, "public"), { maxAge: 0 }));

// --- wallet / rpc ----------------------------------------------------------

function decodeSecret(raw) {
  const s = String(raw).trim();
  if (!s) return null;
  let bytes;
  if (s.startsWith("[")) {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) throw new Error("SOLANA_SECRET_KEY JSON must be an array");
    bytes = Uint8Array.from(arr);
  } else {
    bytes = bs58.decode(s);
  }
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error("SOLANA_SECRET_KEY must be 32 or 64 bytes (JSON array or base58)");
}

let faucetKeypair = null;
if (process.env.SOLANA_SECRET_KEY) {
  try {
    faucetKeypair = decodeSecret(process.env.SOLANA_SECRET_KEY);
  } catch (err) {
    console.error("Could not load SOLANA_SECRET_KEY:", err.message);
    faucetKeypair = null;
  }
}

function getConnection() {
  if (!RPC_URL || !faucetKeypair) return null;
  return new Connection(RPC_URL, "confirmed");
}

function donateAddress() {
  if (process.env.FAUCET_DONATE_ADDRESS && process.env.FAUCET_DONATE_ADDRESS.trim()) {
    return process.env.FAUCET_DONATE_ADDRESS.trim();
  }
  if (faucetKeypair) return faucetKeypair.publicKey.toBase58();
  return DONATE_PLACEHOLDER;
}

async function readBalance() {
  const conn = getConnection();
  if (!conn) return { state: "unfunded", text: "◎ unfunded" };
  try {
    const lamports = await conn.getBalance(faucetKeypair.publicKey, "confirmed");
    const sol = lamports / LAMPORTS_PER_SOL;
    const pretty = sol.toLocaleString("en-US", { maximumFractionDigits: 4, minimumFractionDigits: 0 });
    return { state: "live", lamports, text: "◎ " + pretty + " available" };
  } catch (err) {
    console.error("balance error:", err.message);
    return { state: "unknown", text: "◎ — available" };
  }
}

// --- rate limit (IP + address), persisted ----------------------------------

function loadClaims() {
  try {
    return JSON.parse(fs.readFileSync(CLAIMS_PATH, "utf8"));
  } catch {
    return { ips: {}, addresses: {}, recent: [] };
  }
}

function saveClaims(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CLAIMS_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("could not persist claims:", err.message);
  }
}

function prune(map, now) {
  for (const k of Object.keys(map)) {
    if (now - map[k] > CLAIM_WINDOW_MS) delete map[k];
  }
}

function alreadyClaimed(ip, address) {
  const now = Date.now();
  const data = loadClaims();
  prune(data.ips, now);
  prune(data.addresses, now);
  saveClaims(data);
  if (data.ips[ip] && now - data.ips[ip] < CLAIM_WINDOW_MS) return "ip";
  if (data.addresses[address] && now - data.addresses[address] < CLAIM_WINDOW_MS) return "address";
  return null;
}

function recordClaim(ip, address, signature) {
  const now = Date.now();
  const data = loadClaims();
  data.ips = data.ips || {};
  data.addresses = data.addresses || {};
  data.recent = data.recent || [];
  data.ips[ip] = now;
  data.addresses[address] = now;
  data.recent.unshift({ at: now, address, signature });
  data.recent = data.recent.slice(0, 8);
  saveClaims(data);
}

function lastDripText() {
  const data = loadClaims();
  const rec = (data.recent || [])[0];
  if (!rec) return "";
  const mins = Math.max(1, Math.round((Date.now() - rec.at) / 60000));
  if (mins < 60) return "last drip ~" + mins + " min ago";
  const hours = Math.round(mins / 60);
  if (hours < 48) return "last drip ~" + hours + " hr ago";
  return "last drip ~" + Math.round(hours / 24) + " days ago";
}

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf && typeof xf === "string") return xf.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

// --- captcha (distorted-text SVG, generated on the server) -----------------

const CAPTCHA_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomText(n) {
  const buf = crypto.randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += CAPTCHA_ALPHABET[buf[i] % CAPTCHA_ALPHABET.length];
  return s;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function captchaSvg(text) {
  const w = 170;
  const h = 52;
  const parts = [];
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '">');
  parts.push('<rect width="100%" height="100%" fill="#e9e9e9"/>');
  for (let i = 0; i < 18; i++) {
    const x = Math.floor(Math.random() * w);
    const y = Math.floor(Math.random() * h);
    const r = 1 + Math.floor(Math.random() * 2);
    parts.push('<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="#bbb"/>');
  }
  for (let i = 0; i < 5; i++) {
    const x1 = Math.floor(Math.random() * w);
    const y1 = Math.floor(Math.random() * h);
    const x2 = Math.floor(Math.random() * w);
    const y2 = Math.floor(Math.random() * h);
    const shade = 140 + Math.floor(Math.random() * 70);
    parts.push(
      '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 +
        '" stroke="rgb(' + shade + "," + shade + "," + shade + ')" stroke-width="1"/>'
    );
  }
  for (let i = 0; i < text.length; i++) {
    const x = 16 + i * 30 + Math.floor(Math.random() * 5);
    const y = 34 + Math.floor(Math.random() * 10) - 4;
    const rot = (Math.random() * 42 - 21).toFixed(1);
    const size = 26 + Math.floor(Math.random() * 8);
    const fill = Math.random() > 0.5 ? "#2a2a2a" : "#3d4a5c";
    parts.push(
      '<text x="' + x + '" y="' + y + '" font-size="' + size +
        '" font-family="Georgia, Times, serif" font-style="italic" fill="' + fill +
        '" transform="rotate(' + rot + " " + x + " " + y + ')">' +
        escapeXml(text[i]) + "</text>"
    );
  }
  parts.push("</svg>");
  return parts.join("");
}

function issueCaptcha(req) {
  const text = randomText(5);
  req.session.captcha = text;
  req.session.captchaAt = Date.now();
  return text;
}

function checkCaptcha(req, guess) {
  const expected = req.session && req.session.captcha;
  const at = req.session && req.session.captchaAt;
  req.session.captcha = null;
  req.session.captchaAt = null;
  if (!expected || !guess) return false;
  if (at && Date.now() - at > 15 * 60 * 1000) return false;
  const a = String(expected).trim().toUpperCase();
  const b = String(guess).trim().toUpperCase();
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// --- address check ---------------------------------------------------------

function parseSolanaAddress(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (s.length < 32 || s.length > 44) return null;
  try {
    const pk = new PublicKey(s);
    if (!PublicKey.isOnCurve(pk.toBytes())) return null;
    return pk;
  } catch {
    return null;
  }
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- page ------------------------------------------------------------------

function renderPage({ balanceText, lastDrip, donate, messageHtml, addressValue }) {
  const lastLine = lastDrip ? "\n        <p>" + esc(lastDrip) + "</p>" : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML Basic 1.1//EN"
 "http://www.w3.org/TR/xhtml-basic/xhtml-basic11.dtd">
<!-- Design by www.yomena.de, originally from http://www.opendesigns.org/design/tomotoe/ -->
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
  <head>
    <title>Free Solana</title>
    <meta name="author" content="sam"/>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
    <meta name="title" content="The Solana Faucet" />
    <meta name="description" content="The Solana Faucet gives you a little free SOL so you can try this newfangled cryptocurrency." />
    <link rel="stylesheet" type="text/css" href="/fountain.css" />
    <link rel="image_src" href="/faucet.png" />
  </head>
  <body>
    <div class="title">
      <h1>Free Solana</h1>
    </div>
    <div class="leftNav">
        <p>${esc(balanceText)}</p>${lastLine}
      <ul>
        <li>Other Sites:</li>
        <li>
          <a href="https://solana.com">solana.com</a>
        </li>
        <li>
          <a href="https://phantom.app">phantom.app</a>
        </li>
      </ul>
    </div>
    <div class="main">

  <h2>Get Solana from the Solana Faucet</h2>
  <form action="/" method="post">
   ${messageHtml}
   <p>I'm giving away 0.01 SOL per visitor; just solve the captcha then enter your Solana receiving address and press Get&nbsp;Some:</p>
     <div class="captcha-row">
       <img src="/captcha" width="170" height="52" alt="captcha" />
       <label for="id_captcha"> Captcha:</label>
       <input id="id_captcha" type="text" name="captcha" maxlength="8" autocomplete="off" />
     </div>
     <p><label for="id_address">Your Solana Address:</label> <input id="id_address" type="text" name="address" maxlength="48" value="${esc(addressValue || "")}" />
      <input type="submit" value="Get Some!"/></p>
  </form>

      <h2>What are Solanas?</h2>
      <p>Solanas are a new kind of money. They aren't created or controlled by a government
         (like dollars or euros). Anybody who wants to can run the software and be part of
         the network. Visit <a href="https://solana.com">solana.com</a> for the geeky details.</p>

      <h2>How do I get a Solana Receiving Address?</h2>
      <p>Install a wallet such as <a href="https://phantom.app">Phantom</a> or
         <a href="https://solflare.com">Solflare</a> (or use the
         <a href="https://docs.solana.com/cli">Solana CLI</a> if you live in a terminal).
         Open it up — it will show you your receiving address, a long string of letters and numbers.
         Paste that here. A wallet you control is best.</p>

      <h2>I've got Solana; how can I help?</h2>
      <p>Send some to the Solana Faucet at
        address <code><b>${esc(donate)}</b></code> and they'll be given away.
        It may take a little while for your donation to show up in the amount available.
      </p>

      <h2>What's the catch?</h2>
      <p>No catch. I want Solana to be something you can actually try, not just read about.
      A few coins to start with is enough to send a transaction and see how it feels.<br/>
      -- sam
      </p>
    </div>
    <div class="footer">
      Homage to <a href="https://en.wikipedia.org/wiki/Bitcoin_faucet">Gavin Andresen's 2010 Bitcoin Faucet</a>
      (this is not that site, and Gavin did not build this one)
      | Design: <a href="http://www.yomena.de/">www.yomena.de</a>
      | Photo: original garden tap for this page
    </div>
  </body>
</html>
`;
}

function msgErr(text) {
  return '<p class="msg msg-err"><b>Sorry:</b> ' + esc(text) + "</p>";
}
function msgOk(htmlInner) {
  return '<p class="msg msg-ok">' + htmlInner + "</p>";
}

async function page(req, extra) {
  const bal = await readBalance();
  return renderPage({
    balanceText: bal.text,
    lastDrip: lastDripText(),
    donate: donateAddress(),
    messageHtml: (extra && extra.messageHtml) || "",
    addressValue: (extra && extra.addressValue) || "",
  });
}

app.get("/captcha", function (req, res) {
  const text = issueCaptcha(req);
  const svg = captchaSvg(text);
  res.set("Content-Type", "image/svg+xml");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.send(svg);
});

app.get("/", async function (req, res) {
  try {
    res.type("html").send(await page(req, {}));
  } catch (err) {
    console.error(err);
    res.status(500).type("html").send("<p>Something went wrong. Please try again.</p>");
  }
});

app.post("/", async function (req, res) {
  const addressRaw = (req.body && req.body.address) || "";
  const captchaRaw = (req.body && req.body.captcha) || "";
  const ip = clientIp(req);

  const fail = async (text) => {
    res.type("html").send(await page(req, { messageHtml: msgErr(text), addressValue: addressRaw }));
  };

  try {
    if (!checkCaptcha(req, captchaRaw)) {
      return fail("the captcha didn't match. Have another go.");
    }

    const dest = parseSolanaAddress(addressRaw);
    if (!dest) {
      return fail("that doesn't look like a Solana receiving address. It should be the base58 public key your wallet shows you.");
    }

    if (faucetKeypair && dest.equals(faucetKeypair.publicKey)) {
      return fail("that's the faucet's own address. Paste a wallet you control.");
    }

    const hit = alreadyClaimed(ip, dest.toBase58());
    if (hit) {
      return fail("you've already had a drip from this faucet recently. Please come back later so there's some left for the next visitor.");
    }

    if (!faucetKeypair || !RPC_URL) {
      return fail("the faucet is dry right now — it hasn't been funded yet. If you'd like to help, send a little SOL to the donation address below.");
    }

    const conn = getConnection();
    const bal = await conn.getBalance(faucetKeypair.publicKey, "confirmed");
    const feePad = 5000;
    if (bal < PAYOUT_LAMPORTS + feePad) {
      return fail("the faucet is dry right now. Someone drank it down. Donations to the address below get given away again.");
    }

    const ix = SystemProgram.transfer({
      fromPubkey: faucetKeypair.publicKey,
      toPubkey: dest,
      lamports: PAYOUT_LAMPORTS,
    });
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [faucetKeypair], {
      commitment: "confirmed",
    });

    recordClaim(ip, dest.toBase58(), sig);

    const explorer = "https://solscan.io/tx/" + encodeURIComponent(sig);
    const ok = msgOk(
      "Sent 0.01 SOL. Transaction: <a href=\"" + explorer + "\">" + esc(sig) + "</a>"
    );
    res.type("html").send(await page(req, { messageHtml: ok, addressValue: "" }));
  } catch (err) {
    console.error("claim error:", err);
    return fail("I couldn't send the coins just now (" + (err && err.message ? err.message : "rpc error") + "). Try again in a minute.");
  }
});

app.listen(PORT, "0.0.0.0", function () {
  const funded = faucetKeypair ? faucetKeypair.publicKey.toBase58() : "(no key — dry / unfunded)";
  console.log("The Solana Faucet listening on http://127.0.0.1:" + PORT);
  console.log("Payout: " + PAYOUT_SOL + " SOL (" + PAYOUT_LAMPORTS + " lamports)");
  console.log("Faucet wallet: " + funded);
  console.log("RPC: " + (RPC_URL || "(not set)"));
});

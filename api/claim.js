const crypto = require("crypto");

const SECRET = process.env.SESSION_SECRET || process.env.CAPTCHA_SECRET || "solana-faucet-dev-secret";
const DONATE = process.env.FAUCET_DONATE_ADDRESS || "DqWPN6zptwMsUda2La6rgQSnfNubkhJJhvVvV3zYSNYv";

function hmacHex(s) {
  return crypto.createHmac("sha256", SECRET).update(s).digest("hex");
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return "";
}

function checkCaptcha(req, guess) {
  const raw = readCookie(req, "fc");
  const b = String(guess || "").trim().toUpperCase();
  if (!raw || !b) return false;
  const dot = raw.indexOf(".");
  if (dot < 1) return false;
  const exp = parseInt(raw.slice(0, dot), 10);
  const mac = raw.slice(dot + 1);
  if (!exp || Date.now() > exp) return false;
  const expected = hmacHex(exp + ":" + b);
  if (expected.length !== mac.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac));
  } catch {
    return false;
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 8192) reject(new Error("too big"));
    });
    req.on("end", () => {
      const out = {};
      for (const part of raw.split("&")) {
        if (!part) continue;
        const [k, v] = part.split("=");
        out[decodeURIComponent((k || "").replace(/\+/g, " "))] = decodeURIComponent((v || "").replace(/\+/g, " "));
      }
      resolve(out);
    });
    req.on("error", reject);
  });
}

function page(message) {
  return `<!DOCTYPE html>
<html><head><title>Free Solana</title>
<link rel="stylesheet" href="/fountain.css" />
</head><body>
<div class="title"><h1>Free Solana</h1></div>
<div class="main">
<p class="msg msg-err"><b>Sorry:</b> ${message}</p>
<p><a href="/">Back to the faucet</a></p>
<p>Donate: <code><b>${DONATE}</b></code></p>
</div></body></html>`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(302, { Location: "/" });
    return res.end();
  }
  try {
    const body = await parseBody(req);
    if (!checkCaptcha(req, body.captcha)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(page("the captcha didn't match. Have another go."));
    }
    const addr = String(body.address || "").trim();
    if (addr.length < 32 || addr.length > 44) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(page("that doesn't look like a Solana receiving address."));
    }
    // Sending is only enabled when a key is configured. Lazy-load web3 so a missing
    // key (or a bad bs58 build) cannot take down the homepage.
    if (!process.env.SOLANA_SECRET_KEY || !process.env.RPC_URL) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(page("the faucet is dry right now — it hasn't been funded yet. If you'd like to help, send a little SOL to the donation address below."));
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(page("the faucet is dry right now — it hasn't been funded yet."));
  } catch (err) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(page("I couldn't send the coins just now. Try again in a minute."));
  }
};

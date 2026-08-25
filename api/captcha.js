const crypto = require("crypto");

const SECRET = process.env.SESSION_SECRET || process.env.CAPTCHA_SECRET || "solana-faucet-dev-secret";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomText(n) {
  const buf = crypto.randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return s;
}

function hmacHex(s) {
  return crypto.createHmac("sha256", SECRET).update(s).digest("hex");
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
        text[i] + "</text>"
    );
  }
  parts.push("</svg>");
  return parts.join("");
}

module.exports = (req, res) => {
  const text = randomText(5);
  const exp = Date.now() + 15 * 60 * 1000;
  const mac = hmacHex(exp + ":" + text);
  const cookie = "fc=" + encodeURIComponent(exp + "." + mac) + "; HttpOnly; Path=/; SameSite=Lax; Max-Age=900; Secure";
  res.setHeader("Set-Cookie", cookie);
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.status(200).send(captchaSvg(text));
};

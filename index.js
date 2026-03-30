//importing the required modules so we can use their moudueles fucnality in our code
require("dotenv").config();
const express = require('express');
let compression = null;
try {
  compression = require("compression");
} catch {
  compression = null;
}
const cors = require("cors");
const cards = require('./routes/card');
const meta = require('./routes/meta');
const analytics = require('./routes/analytics');
const deck = require('./routes/deck');
const watcher = require('./routes/watcher');
const ai = require('./routes/ai');
const connectDB = require('./config/configdb');
const { startTopicWatcher } = require("./services/topic_watcher_service");
const app = express();
app.set("trust proxy", 1);

// Basic in-memory rate limiter middleware (public API hardening).
const createRateLimiter = ({
  windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max = Number(process.env.RATE_LIMIT_MAX) || 300,
} = {}) => {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const ip = String(req.ip || req.headers["x-forwarded-for"] || "unknown");
    const bucket = hits.get(ip) || { count: 0, ts: now };
    if (now - bucket.ts > windowMs) {
      bucket.count = 0;
      bucket.ts = now;
    }
    bucket.count += 1;
    hits.set(ip, bucket);
    if (bucket.count > max) {
      return res.status(429).json({ message: "Too many requests, please try again shortly." });
    }
    return next();
  };
};

const allowedOrigins = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const normalized = String(origin).replace(/\/+$/, "");
    if (allowedOrigins.length === 0 || allowedOrigins.includes(normalized)) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
};

//parssing the incoimg request body as json data in to the javascript object
app.use(express.json({ limit: "1mb" }));
if (typeof compression === "function") {
  app.use(compression());
}
app.use(cors(corsOptions));
app.use(createRateLimiter());

// Minimal hardening headers.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.get('/',(req,res)=>{
  res.send("Welcome to the Card Game API")
})
app.get('/healthz', (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() });
});
//importing the cards route with mddileare verfication 
//this how we know which api its and whatver api req start with cardsApi that move 
app.use('/cardsApi',cards)
app.use('/meta', meta);
app.use('/analytics', analytics);
app.use('/decks', deck);
app.use('/watcher', watcher);
app.use('/watcher.js', watcher);
app.use('/ai', ai);

app.use((error, req, res, next) => {
  if (error && String(error.message || "").includes("CORS")) {
    return res.status(403).json({ message: "CORS blocked for this origin" });
  }
  return next(error);
});

const port = Number(process.env.PORT) || 3000;
const startServer = async () => {
  try {
    await connectDB();
    const server = app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
      startTopicWatcher();
    });
    server.keepAliveTimeout = Math.max(5_000, Number(process.env.KEEP_ALIVE_TIMEOUT_MS) || 65_000);
    server.headersTimeout = Math.max(server.keepAliveTimeout + 1_000, Number(process.env.HEADERS_TIMEOUT_MS) || 66_000);
    server.requestTimeout = Math.max(10_000, Number(process.env.REQUEST_TIMEOUT_MS) || 120_000);
  } catch (error) {
    console.error("Fatal startup error:", error?.message || error);
    process.exit(1);
  }
};

void startServer();

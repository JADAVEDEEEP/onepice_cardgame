const mongoose = require("mongoose");
const HARDCODED_MONGO_URI =
  "mongodb+srv://jadavdeep560_db_user:bSiiJsKaASjZMf9v@mediware-cluster.xnwbxvv.mongodb.net/card_Game?retryWrites=true&w=majority&appName=mediware-cluster";
const HARDCODED_DB_NAME = "card_Game";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const connectDB = async () => {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || HARDCODED_MONGO_URI;
  const dbName = process.env.MONGO_DB_NAME || HARDCODED_DB_NAME;
  const maxRetries = Math.max(1, Number(process.env.MONGO_CONNECT_RETRIES) || 5);
  const retryDelayMs = Math.max(1000, Number(process.env.MONGO_CONNECT_RETRY_DELAY_MS) || 5000);

  if (!mongoUri) {
    throw new Error("Mongo URI is not configured. Set MONGO_URI (or MONGODB_URI).");
  }

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      await mongoose.connect(mongoUri, {
        dbName,
        serverSelectionTimeoutMS: 30000,
        connectTimeoutMS: 30000,
        socketTimeoutMS: 45000,
        family: 4,
      });
      console.log(`MongoDB Connected (db: ${dbName})`);
      return;
    } catch (error) {
      const message = String(error?.message || error);
      console.error(`Mongo connect failed (${attempt}/${maxRetries}): ${message}`);
      if (
        message.includes("Could not connect to any servers") ||
        message.includes("MongoNetworkTimeoutError")
      ) {
        console.error("Hint: Check Mongo Atlas Network Access (allow 0.0.0.0/0 for Render), URI, and DB user permissions.");
      }
      if (attempt < maxRetries) {
        await sleep(retryDelayMs);
      } else {
        throw error;
      }
    }
  }
};

module.exports = connectDB;

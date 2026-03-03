const mongoose = require("mongoose");
const HARDCODED_MONGO_URI =
  "mongodb+srv://jadavdeep560_db_user:bSiiJsKaASjZMf9v@mediware-cluster.xnwbxvv.mongodb.net/card_Game?retryWrites=true&w=majority&appName=mediware-cluster";
const HARDCODED_DB_NAME = "card_Game";

const connectDB = async () => {
  try {
    const mongoUri = HARDCODED_MONGO_URI;
    if (!mongoUri) {
      throw new Error("HARDCODED_MONGO_URI is not configured");
    }

    await mongoose.connect(mongoUri, {
      dbName: HARDCODED_DB_NAME,
      serverSelectionTimeoutMS: 10000,
    });
    console.log("MongoDB Connected");
  } catch (error) {
    console.error("Mongo Error:", error);
    process.exit(1);
  }
};

module.exports = connectDB;

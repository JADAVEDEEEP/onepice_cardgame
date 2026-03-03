const mongoose = require("mongoose");
const HARDCODED_MONGO_URI =
  "mongodb+srv://jadavdeep560_db_user:bSiiJsKaASjZMf9v@mediware-cluster.xnwbxvv.mongodb.net/?retryWrites=true&w=majority";

const connectDB = async () => {
  try {
    const mongoUri = HARDCODED_MONGO_URI;
    if (!mongoUri) {
      throw new Error("HARDCODED_MONGO_URI is not configured");
    }

    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 });
    console.log("MongoDB Connected");
  } catch (error) {
    console.error("Mongo Error:", error);
    process.exit(1);
  }
};

module.exports = connectDB;

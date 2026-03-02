const mongoose = require("mongoose");

// Connect MongoDB using environment variable for production safety
const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
      throw new Error("MONGO_URI is not configured");
    }

    await mongoose.connect(mongoUri);
    console.log("MongoDB Connected");
  } catch (error) {
    console.error("Mongo Error:", error.message);
    process.exit(1);
  }
};

module.exports = connectDB;

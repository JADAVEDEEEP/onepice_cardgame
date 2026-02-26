const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    await mongoose.connect(
      "mongodb+srv://jadavdeep560_db_user:bSiiJsKaASjZMf9v@mediware-cluster.xnwbxvv.mongodb.net/card_Game"
    );

    console.log("MongoDB Connected 🚀");
  } catch (error) {
    console.error("Mongo Error:", error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
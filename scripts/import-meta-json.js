require("dotenv").config();
const fs = require("fs");
const path = require("path");
const connectDB = require("../config/configdb");
const metaLeaderDb = require("../model/meta_leader_db");

const META_FILE_PATH = path.resolve(__dirname, "../../One-Piece-TCG-Learning-Guide/meta.json");

const normalizeLeaderCode = (value) => String(value || "").trim().replace(/^1x/i, "");

const run = async () => {
  await connectDB();

  const raw = fs.readFileSync(META_FILE_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const leaders = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.leaders) ? parsed.leaders : [];

  if (leaders.length === 0) {
    throw new Error("No leaders found in meta.json");
  }

  let imported = 0;
  for (const leader of leaders) {
    const leaderCode = normalizeLeaderCode(leader?.leader);
    if (!leaderCode) continue;

    await metaLeaderDb.findOneAndUpdate(
      { leader: leaderCode },
      {
        ...leader,
        leader: leaderCode,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    imported += 1;
  }

  console.log(`Imported ${imported} leader meta records from ${META_FILE_PATH}`);
  process.exit(0);
};

run().catch((error) => {
  console.error("Failed to import meta.json:", error?.message || error);
  process.exit(1);
});

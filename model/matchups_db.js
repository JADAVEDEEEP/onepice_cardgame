const mongoose = require("mongoose");

const opponentMatchupSchema = new mongoose.Schema(
  {
    opponent: { type: String, trim: true, default: "" },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    games: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 },
    first_wr: { type: Number, default: 0 },
    second_wr: { type: Number, default: 0 },
    first_games: { type: Number, default: 0 },
    second_games: { type: Number, default: 0 },
  },
  { _id: false, strict: false }
);

const leaderMatchupSchema = new mongoose.Schema(
  {
    leader: { type: String, required: true, trim: true },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    number_of_matches: { type: Number, default: 0 },
    duration: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 },
    avgDuration: { type: Number, default: 0 },
    popularity: { type: Number, default: 0 },
    matchups: { type: [opponentMatchupSchema], default: [] },
  },
  { _id: false, strict: false }
);

const matchupDatasetSchema = new mongoose.Schema(
  {
    matchups: { type: [leaderMatchupSchema], default: [] },
    total_matches: { type: Number, default: 0 },
  },
  { timestamps: true, strict: false }
);

matchupDatasetSchema.index({ updatedAt: -1, createdAt: -1 });

module.exports = mongoose.model(
  "MatchupDataset",
  matchupDatasetSchema,
  process.env.MATCHUPS_COLLECTION || "onepice_card_game_matchups"
);

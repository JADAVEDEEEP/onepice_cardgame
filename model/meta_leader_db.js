const mongoose = require("mongoose");

const metaLeaderSchema = new mongoose.Schema(
  {
    leader: { type: String, required: true, index: true, trim: true },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    number_of_matches: { type: Number, default: 0 },
    duration: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 },
    avgDuration: { type: Number, default: 0 },
    popularity: { type: Number, default: 0 },
    cards: { type: [mongoose.Schema.Types.Mixed], default: [] },
    totalCards: { type: Number, default: 0 },
    setName: { type: String, default: "" },
    debug: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, strict: false }
);

metaLeaderSchema.index({ leader: 1 });
metaLeaderSchema.index({ popularity: -1, winRate: -1 });

module.exports = mongoose.model(
  "MetaLeader",
  metaLeaderSchema,
  process.env.META_LEADERS_COLLECTION || "onepice_game_meta_decks"
);

const mongoose = require("mongoose");

const deckEntrySchema = new mongoose.Schema(
  {
    deck: [{ type: String }],
    games: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    avgDuration: { type: Number, default: 0 },
  },
  { _id: false, strict: false }
);

const decklistSchema = new mongoose.Schema(
  {
    leader: { type: String, index: true, trim: true },
    card_id: { type: String, index: true, trim: true },
    image: { type: String, default: "" },
    leaderCard: { type: String, default: "" },
    setName: { type: String, index: true, trim: true },
    leaderWinRate: { type: Number, default: 0 },
    totalDecklists: { type: Number, default: 0 },
    decklists: [deckEntrySchema],
    url: { type: String, default: "" },
  },
  { timestamps: true, strict: false }
);

decklistSchema.index({ leader: 1, card_id: 1 });
decklistSchema.index({ setName: 1 });
decklistSchema.index({ leader: 1, setName: 1 });

module.exports = mongoose.model(
  "Decklist",
  decklistSchema,
  "onepice_card_game_new_Decklist"
);

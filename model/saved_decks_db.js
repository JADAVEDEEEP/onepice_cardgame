const mongoose = require("mongoose");

const savedDeckSchema = new mongoose.Schema(
  {
    deck_name: { type: String, required: true, trim: true },
    leader: {
      card_code: { type: String, default: "" },
      name: { type: String, default: "" },
      color: { type: String, default: "" },
    },
    deck_cards: [
      {
        card_code: { type: String, required: true },
        count: { type: Number, required: true, min: 1 },
      },
    ],
    tags: [{ type: String }],
    notes: { type: String, default: "" },
    deck_size: { type: Number, default: 0 },
    source: { type: String, default: "public" },
  },
  { timestamps: true, strict: false }
);

module.exports = mongoose.model(
  "SavedDeck",
  savedDeckSchema,
  process.env.SAVED_DECKS_COLLECTION || "onepice_game_saved_decks"
);


const mongoose = require("mongoose");

const standingsSchema = new mongoose.Schema(
  {
    tournament: String,
    date: String,
    format: String,
    placement: mongoose.Schema.Types.Mixed,
    player: String,
    deck: String,
    leaderImage: String,
  },
  { strict: false }
);

standingsSchema.index({ deck: 1 });
standingsSchema.index({ format: 1, date: 1 });
standingsSchema.index({ tournament: 1, date: 1, format: 1 });
standingsSchema.index({ date: 1 });

module.exports = mongoose.model(
  "Standing",
  standingsSchema,
  process.env.STANDINGS_COLLECTION || "onepice_game_standings"
);

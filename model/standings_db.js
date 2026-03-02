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

module.exports = mongoose.model(
  "Standing",
  standingsSchema,
  process.env.STANDINGS_COLLECTION || "onepice_game_standings"
);

const mongoose = require("mongoose");

const tournamentSchema = new mongoose.Schema(
  {
    date: String,
    region: String,
    country: String,
    name: String,
    format: String,
    players: mongoose.Schema.Types.Mixed,
    winner: String,
    link: String,
  },
  { strict: false }
);

module.exports = mongoose.model(
  "Tournament",
  tournamentSchema,
  process.env.TOURNAMENTS_COLLECTION || "onepice_game_tournaments"
);

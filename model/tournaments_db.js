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

tournamentSchema.index({ name: 1 });
tournamentSchema.index({ format: 1, date: 1 });
tournamentSchema.index({ region: 1, country: 1, date: 1 });
tournamentSchema.index({ name: 1, format: 1, date: 1 });

module.exports = mongoose.model(
  "Tournament",
  tournamentSchema,
  process.env.TOURNAMENTS_COLLECTION || "onepice_game_tournaments"
);

const mongoose = require("mongoose");

const cardSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  pack_id: String,
  name: String,
  rarity: String,
  category: String,
  img_url: String,
  img_full_url: String,
  colors: [String],
  cost: Number,
  attributes: [String],
  power: Number,
  counter: Number,
  types: [String],
  effect: String,
  trigger: String
});

module.exports = mongoose.model(
  "Card",
  cardSchema,
  "onepice_game_Cards"
);
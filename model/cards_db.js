const mongoose = require("mongoose");
//this is the card schema that define the structure of the card data in the database and also define the data types of each field in the card data and also define the collection name in the database where the card data will be stored
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
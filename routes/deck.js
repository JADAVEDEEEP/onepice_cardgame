const express = require("express");
const {
  saveDeck,
  listSavedDecks,
  getSavedDeckById,
} = require("../controller/saved_deck_controller");

const router = express.Router();

router.post("/save", saveDeck);
router.get("/", listSavedDecks);
router.get("/:deckId", getSavedDeckById);

module.exports = router;

const express = require("express");
const {
  saveDeck,
  listSavedDecks,
  getSavedDeckById,
  updateSavedDeck,
  deleteSavedDeck,
} = require("../controller/saved_deck_controller");

const router = express.Router();

router.post("/save", saveDeck);
router.get("/", listSavedDecks);
router.get("/:deckId", getSavedDeckById);
router.put("/:deckId", updateSavedDeck);
router.delete("/:deckId", deleteSavedDeck);

module.exports = router;

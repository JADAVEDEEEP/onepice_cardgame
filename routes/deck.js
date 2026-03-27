const express = require("express");
const {
  saveDeck,
  listSavedDecks,
  getSavedDeckById,
} = require("../controller/saved_deck_controller");
const { listDecklists } = require("../controller/decklist_controller");
const { getMatchups } = require("../controller/matchups_controller");

const router = express.Router();

router.get("/decklist", listDecklists);
router.get("/matchups", getMatchups);
router.post("/save", saveDeck);
router.get("/", listSavedDecks);
router.get("/:deckId", getSavedDeckById);

module.exports = router;

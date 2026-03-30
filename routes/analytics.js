const express = require("express");
const {
  optimizeDeck,
  bestColorFinder,
  generateBestDeck,
  getMatchupMatrix,
  getSavedDeckProfile,
  compareDecksWithAI,
} = require("../controller/analytics_controller");

const router = express.Router();

router.post("/optimize", optimizeDeck);
router.post("/best-color", bestColorFinder);
router.post("/generate-best-deck", generateBestDeck);
router.post("/compare-decks-ai", compareDecksWithAI);
router.get("/matchup-matrix", getMatchupMatrix);
//this get route will retrun save deck data by id to the client 
router.get("/saved-deck-profile/:deckId", getSavedDeckProfile);

module.exports = router;

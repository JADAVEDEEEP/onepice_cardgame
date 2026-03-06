const express = require("express");
const {
  optimizeDeck,
  bestColorFinder,
  generateBestDeck,
  getMatchupMatrix,
  getSavedDeckProfile,
} = require("../controller/analytics_controller");

const router = express.Router();

router.post("/optimize", optimizeDeck);
router.post("/best-color", bestColorFinder);
router.post("/generate-best-deck", generateBestDeck);
router.get("/matchup-matrix", getMatchupMatrix);
router.get("/saved-deck-profile/:deckId", getSavedDeckProfile);

module.exports = router;

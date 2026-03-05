const express = require("express");
const {
  optimizeDeck,
  bestColorFinder,
  generateBestDeck,
  getMatchupMatrix,
} = require("../controller/analytics_controller");

const router = express.Router();

router.post("/optimize", optimizeDeck);
router.post("/best-color", bestColorFinder);
router.post("/generate-best-deck", generateBestDeck);
router.get("/matchup-matrix", getMatchupMatrix);

module.exports = router;

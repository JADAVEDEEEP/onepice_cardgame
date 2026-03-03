const express = require("express");
const {
  optimizeDeck,
  bestColorFinder,
  generateBestDeck,
} = require("../controller/analytics_controller");

const router = express.Router();

router.post("/optimize", optimizeDeck);
router.post("/best-color", bestColorFinder);
router.post("/generate-best-deck", generateBestDeck);

module.exports = router;

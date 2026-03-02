const express = require("express");
const { getBestDeck, getDeckDetails } = require("../controller/meta_controller");

const router = express.Router();

router.get("/best-deck", getBestDeck);
router.get("/deck/:deckName", getDeckDetails);

module.exports = router;

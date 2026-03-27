const express = require("express");
const { getBestDeck, getDeckDetails } = require("../controller/meta_controller");
const { listMetaLeaders, getMetaLeaderByCode } = require("../controller/meta_leader_controller");

const router = express.Router();

router.get("/leaders", listMetaLeaders);
router.get("/leaders/:leaderCode", getMetaLeaderByCode);
router.get("/best-deck", getBestDeck);
router.get("/deck/:deckName", getDeckDetails);

module.exports = router;

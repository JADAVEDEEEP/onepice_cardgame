const express = require("express");
const { getCoachAnalysis, getGuideAssistance, getDeckVerdict, getCardIntelligence } = require("../controller/ai_controller");

const router = express.Router();

router.post("/coach", getCoachAnalysis);
router.post("/guide-assist", getGuideAssistance);
router.post("/verdict", getDeckVerdict);
router.post("/card-intel", getCardIntelligence);

module.exports = router;

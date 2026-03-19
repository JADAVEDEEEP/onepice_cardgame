const express = require("express");
const { getCoachAnalysis, getGuideAssistance } = require("../controller/ai_controller");

const router = express.Router();

router.post("/coach", getCoachAnalysis);
router.post("/guide-assist", getGuideAssistance);

module.exports = router;

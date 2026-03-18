const express = require("express");
const { getCoachAnalysis } = require("../controller/ai_controller");

const router = express.Router();

router.post("/coach", getCoachAnalysis);

module.exports = router;

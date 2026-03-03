const express = require("express");
const { optimizeDeck } = require("../controller/analytics_controller");

const router = express.Router();

router.post("/optimize", optimizeDeck);

module.exports = router;


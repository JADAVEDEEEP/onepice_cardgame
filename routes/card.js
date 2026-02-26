const express = require('express');
const { getCards } = require('../controller/card_controller');

const router = express.Router();

router.get('/cards',getCards)

module.exports = router;
const express = require('express');
const { getCards } = require('../controller/card_controller');

const router = express.Router();
//this cards get route its return cards data to the client
//when client send the get req to the /cards route that get req handle by the app.get route and express will match the /cards get route and execute the get cards call back function and that function will execute the business Logic of sending the cards data as res to the client

router.get('/cards',getCards)

//export the router to be used in the main app.js file
module.exports = router;
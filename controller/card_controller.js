const cards_db = require("../model/cards_db")

//this get cards function will excute the cards data and send the cards data to the client as a json response
// Get all cards : it will be used to get all the cards in the database and send it to the client 
const getCards = async (req, res) => {
   // Get all cards from the database using the find method of the cards_db model and send it to the client as a json response  
  const cards = await cards_db.find()
 //send the cards data as jsont response to the client
  res.json(cards)
  
}
module.exports = {
    getCards
}
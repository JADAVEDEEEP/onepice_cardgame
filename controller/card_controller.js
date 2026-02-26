const cards_db = require("../model/cards_db")

const getCards = async (req, res) => {
   
  const cards = await cards_db.find()

  res.json(cards)
  
}
module.exports = {
    getCards
}
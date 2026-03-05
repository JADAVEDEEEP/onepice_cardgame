const cards_db = require("../model/cards_db")

// Yeh function database se saare cards nikal kar client ko JSON me bhejta hai.
const getCards = async (req, res) => {
  // Yahan cards collection par simple find() chalaya gaya hai.
  const cards = await cards_db.find()
  // Yahan final cards list response me return ho rahi hai.
  res.json(cards)
  
}
module.exports = {
    getCards
}

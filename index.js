//importing the required modules so we can use their moudueles fucnality in our code
require("dotenv").config();
const express = require('express');
const bodyparser = require('body-parser');
const cors = require("cors");
const cards = require('./routes/card');
const meta = require('./routes/meta');
const connectDB = require('./config/configdb');
const app = express();

//connect to the database
connectDB();
//parssing the incoimg request body as json data in to the javascript object
app.use(bodyparser.json());
const allowedOrigins = ["https://onepice-cardgame-frontend.vercel.app"];

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
  })
);


app.get('/',(req,res)=>{
  res.send("Welcome to the Card Game API")
})
//importing the cards route with mddileare verfication 
//this how we know which api its and whatver api req start with cardsApi that move 
app.use('/cardsApi',cards)
app.use('/meta', meta);


const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

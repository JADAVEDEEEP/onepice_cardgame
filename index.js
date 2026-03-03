//importing the required modules so we can use their moudueles fucnality in our code
require("dotenv").config();
const express = require('express');
const bodyparser = require('body-parser');
const cors = require("cors");
const cards = require('./routes/card');
const meta = require('./routes/meta');
const connectDB = require('./config/configdb');
const app = express();
const defaultOrigins = ["https://onepice-cardgame-frontend.vercel.app"];

//connect to the database
connectDB();
//parssing the incoimg request body as json data in to the javascript object
app.use(bodyparser.json());
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)
  .map((origin) => origin.replace(/\/+$/, ""));

const corsOrigins = Array.from(new Set([...defaultOrigins, ...allowedOrigins]));
const vercelPreviewPattern = /^https:\/\/onepice-cardgame-frontend(-[a-z0-9-]+)?\.vercel\.app$/i;

app.use(
  cors({
    origin: (origin, callback) => {
      // Requests from tools like Postman/curl may not send Origin.
      if (!origin) return callback(null, true);

      const normalizedOrigin = origin.replace(/\/+$/, "");
      if (corsOrigins.includes(normalizedOrigin)) return callback(null, true);
      if (vercelPreviewPattern.test(normalizedOrigin)) return callback(null, true);

      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
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

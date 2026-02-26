const express = require('express');
const bodyparser = require('body-parser');
const cards = require('./routes/card');
connectDB = require('./config/configdb');
const app = express();


connectDB();
app.use(bodyparser.json());

app.use('/cardsApi',cards)


app.listen(3000, () => {
    console.log('Server is running on port 3000');
});
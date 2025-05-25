var express = require('express');
var app = express();app.get('/', function (req, res) {
  res.send('Tui Farms');
});app.listen(3000, function () {
  console.log('Port: 3000');
});
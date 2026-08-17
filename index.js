var express = require('express');
const app = express()
const path = require('path')
const fs = require("fs");
app.use(express.static(path.join(__dirname, 'public')))
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// View Engine Setup
app.set('views', path.join(__dirname, 'views'))
app.set('view engine', 'ejs')

app.get('/', function (req, res) {
  res.render('home')
})


// Client Side

app.get('/beef', function (req, res) {
  fs.readFile("data/beefItems.txt", "utf-8", (err, data) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Error reading beef items file.");
    }

    const lines = data.trim().split("\n");
    const headers = lines.shift().split(",");
    const items = lines.map(line => {
      const values = line.split(",");
      return {
        name: values[0].trim(),
        weightRange: values[1].trim(),
        price: values[2].trim(),
        quantity: values[3].trim(),
      };
    });

    res.render("beef", { items });
  });
})


// Admin Side ------------------------------------------------------
// Utility to read file -> array
function readBeefItems() {
  const data = fs.readFileSync("data/beefItems.txt", "utf-8").trim().split("\n");
  data.shift(); // remove header
  return data.map(line => {
    const [name, weightRange, price, quantity] = line.split(",");
    return {
      name: name.trim(),
      weightRange: weightRange.trim(),
      price: price.trim(),
      quantity: quantity.trim(),
    };
  });
}

// Utility to write array -> file (rebuild CSV text)
function writeBeefItems(items) {
  const header = "name, weight range per package (lbs), price per pound, quantity available";
  const lines = items.map(
    i => `${i.name},${i.weightRange},${i.price},${i.quantity}`
  );
  fs.writeFileSync("data/beefItems.txt", header + "\n" + lines.join("\n"));
}

// ADMIN PAGE DISPLAY
app.get("/admin-beef", (req, res) => {
  const items = readBeefItems();
  res.render("admin-beef", { items, message: null });
});

// SAVE CHANGES (Add / Update / Delete)
app.post("/admin-beef", (req, res) => {
  const items = JSON.parse(req.body.itemsJSON);
  writeBeefItems(items);
  const updatedItems = readBeefItems();
  res.render("admin-beef", {
    items: updatedItems,
    message: "✅ Successfully updated beef items list!"
  });
});


app.listen(process.env.PORT || 80, function () {
  console.log('Port: ' + (process.env.PORT || 80));
});

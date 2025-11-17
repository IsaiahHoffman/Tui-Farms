var express = require('express');
const app = express()
const path = require('path')
const fetch = require("node-fetch");
const axios = require('axios');
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

/////////////////////////////////////////////////////////////////////////
// ADMIN PAGE DISPLAY
app.get("/admin-beef", (req, res) => {
  const items = readBeefItems();
  res.render("admin-beef", { items, message: null });
});

/////////////////////////////////////////////////////////////////////////
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

















// app.get('/strawberry-patch', function (req, res) {
//   res.render('strawberry-patch')
// })

// app.get('/bnb', function (req, res) {
//   res.render('bnb')
// })

// app.get('/tui-beef', (req, res) => {
//   const filePath = path.join(__dirname, 'items.txt');

//   fs.readFile(filePath, 'utf8', (err, data) => {
//     if (err) {
//       console.error('Failed to read beef.txt:', err);
//       return res.status(500).send("Failed to load beef items");
//     }

//     const items = data
//       .split('\n')
//       .map(line => line.trim())
//       .filter(line => line.length > 0)
//       .map(line => {
//         const [name, quantity, price] = line.split('|').map(s => s.trim());
//         return {
//           name,
//           quantity: parseInt(quantity),
//           price: parseFloat(price),
//         };
//       });

//     res.render('Beef/tui-beef', { items });
//   });
// });

// app.get('/tui-dairy', function (req, res) {
//   res.render('tui-dairy')
// })







// ///////////////// Admin End //////////////////////////////////////////////////

// app.get('/beef-admin', function (req, res) {
//   res.render('Beef/beef-admin')
// })

// app.post("/update-list", (req, res) => {
//   const items = req.body.items;

//   if (!Array.isArray(items)) {
//     return res.status(400).send("Invalid data format");
//   }

//   const content = items.join("\n");

//   fs.writeFile("items.txt", content, (err) => {
//     if (err) {
//       console.error("Error writing file:", err);
//       return res.status(500).send("Error saving file");
//     }

//     res.status(200).send("List updated");
//   });
// });

// app.get("/load-list", (req, res) => {
//   fs.readFile("items.txt", "utf-8", (err, data) => {
//     if (err) {
//       // If file doesn't exist, return empty list
//       if (err.code === "ENOENT") return res.json({ items: [] });
//       return res.status(500).send("Error reading file");
//     }

//     const items = data
//       .split("\n")
//       .map(line => line.trim())
//       .filter(line => line.length > 0);

//     res.json({ items });
//   });
// });





// /////////////////////////////  CAMERAS  //////////////////////////////////////////////
// let cameras = []
// let cameraRequested = ""
// let cameraRequestResolve = null;
// let videoUploadResolve = null;
// let videoBuffer = null;


// // Loads page with cameras available
// app.get('/cameras', function (req, res) {
//   let data = {
//     cameras: cameras
//   };
//   res.render('cameras', data)
// })


// // Requests footage for certain camera. 
// app.post('/get-video', async function (req, res) {
//   const data = req.body;
//   cameraRequested = data
//   cameraRequestResolve();  
//   cameraRequestResolve = null;



//   // Wait for response from client
//   const waitForTrigger = new Promise(resolve => {
//     videoUploadResolve = resolve;
//   });
//   // Wait here until resolved by Request B
//   await waitForTrigger;
//   // Send video back
//   if (!videoBuffer) {
//     return res.status(404).send('No video available');
//   }

//   res.setHeader('Content-Type', 'video/mp4');
//   res.setHeader('Content-Length', videoBuffer.length);
//   res.send(videoBuffer);
// })



// app.post('/video-return', async function (req, res) {
//   // hand off video
//   const chunks = [];

//   req.on('data', chunk => {
//     // console.log(`📦 Received chunk: ${chunk.length} bytes`);
//     chunks.push(chunk)
//   });

//   req.on('end', () => {
//     videoBuffer = Buffer.concat(chunks);
//     // console.log("✅ BUFFING STUFF: Video fully received, size:", videoBuffer.length);
//     videoUploadResolve();    // resolve the Promise to resume Request A
//     videoUploadResolve = null;
//     res.send('Video received');
//   });

//   req.on('error', err => {
//     console.error('Error receiving video:', err);
//     res.status(500).send('Failed to receive video');
//   });
// })




// // Home server sends data in and waits for a request
// app.post('/camera-data', async function (req, res) {
//   const data = req.body;
//   cameras = data['cameras']
//   // cameras.push(...data['cameras']);
//   // Wait for response from client
//   const waitForTrigger = new Promise(resolve => {
//     cameraRequestResolve = resolve;
//   });
//   // Wait here until resolved by Request B
//   await waitForTrigger;
//   // Get data from client and make request for camera
//   res.json({ cameraRequested: cameraRequested })
// })






app.listen(80, function () {
  console.log('Port: 80');
});
var express = require('express');
const app = express()
const path = require('path')
const fetch = require("node-fetch");
const axios = require('axios');
app.use(express.static(path.join(__dirname, 'public')))
app.use(express.json());

// View Engine Setup
app.set('views', path.join(__dirname, 'views'))
app.set('view engine', 'ejs')

app.get('/', function (req, res) {
  res.render('home')
})

app.get('/strawberry-patch', function (req, res) {
  res.render('strawberry-patch')
})

app.get('/bnb', function (req, res) {
  res.render('bnb')
})

app.get('/tui-beef', function (req, res) {
  res.render('tui-beef')
})

app.get('/tui-dairy', function (req, res) {
  res.render('tui-dairy')
})







/////////////////////////////  CAMERAS  //////////////////////////////////////////////
let cameras = []
let cameraRequested = ""
let cameraRequestResolve = null;
let videoUploadResolve = null;
let videoBuffer = null;


// Loads page with cameras available
app.get('/cameras', function (req, res) {
  let data = {
    cameras: cameras
  };
  res.render('cameras', data)
})


// Requests footage for certain camera. 
app.post('/get-video', async function (req, res) {
  const data = req.body;
  cameraRequested = data
  cameraRequestResolve();  
  cameraRequestResolve = null;



  // Wait for response from client
  const waitForTrigger = new Promise(resolve => {
    videoUploadResolve = resolve;
  });
  // Wait here until resolved by Request B
  await waitForTrigger;
  // Send video back
  if (!videoBuffer) {
    return res.status(404).send('No video available');
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', videoBuffer.length);
  res.send(videoBuffer);
})



app.post('/video-return', async function (req, res) {
  // hand off video
  const chunks = [];

  req.on('data', chunk => {
    // console.log(`📦 Received chunk: ${chunk.length} bytes`);
    chunks.push(chunk)
  });

  req.on('end', () => {
    videoBuffer = Buffer.concat(chunks);
    // console.log("✅ BUFFING STUFF: Video fully received, size:", videoBuffer.length);
    videoUploadResolve();    // resolve the Promise to resume Request A
    videoUploadResolve = null;
    res.send('Video received');
  });

  req.on('error', err => {
    console.error('Error receiving video:', err);
    res.status(500).send('Failed to receive video');
  });
})




// Home server sends data in and waits for a request
app.post('/camera-data', async function (req, res) {
  const data = req.body;
  cameras = data['cameras']
  // cameras.push(...data['cameras']);
  // Wait for response from client
  const waitForTrigger = new Promise(resolve => {
    cameraRequestResolve = resolve;
  });
  // Wait here until resolved by Request B
  await waitForTrigger;
  // Get data from client and make request for camera
  res.json({ cameraRequested: cameraRequested })
})






app.listen(80, function () {
  console.log('Port: 80');
});
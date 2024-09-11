require('dotenv').config();
const { processAllCosmopolitanProducts } = require('./productFunctions');
const { fetchAndSendRealOrder, updateOrdersWithTrackingFromCosmopolitan } = require('./orderFunctions');


const args = process.argv.slice(2);

if (args[0] === 'products') {
  processAllCosmopolitanProducts().then(() => {
    console.log("Finished processing Cosmopolitan products.");
  }).catch(error => {
    console.error("An error occurred during processing:", error);
  });
} else if (args[0] === 'orders') {
  fetchAndSendRealOrder().then(() => {
    console.log("Finished processing orders.");
  }).catch(error => {
    console.error("An error occurred during order processing:", error);
  });
} else if (args[0] === 'update-tracking') {
  updateOrdersWithTrackingFromCosmopolitan().then(() => {
    console.log("Finished updating orders with tracking.");
  }).catch(error => {
    console.error("An error occurred during the update process:", error);
  });
} else {
  console.log("Please specify a function to run: 'products', 'orders', or 'update-tracking'");


// Ensure the application binds to the port provided by Heroku
const http = require('http'); // Add this line to require the http module

 // If no valid argument is provided, start a simple HTTP server to bind to the port
 const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Server is running\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
}

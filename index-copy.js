require('dotenv').config();
const axios = require('axios');
const nodemailer = require('nodemailer');
console.log("Script started");


const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});


// Define a fixed percentage margin
const MARGIN_PERCENTAGE = 10; // Example: 10% margin

// Shopify API configuration
const shopifyAPI = axios.create({
  baseURL: `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-04`,
  headers: {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': process.env.SHOPIFY_API_PASSWORD
  }
});

// Cosmopolitan API configuration
const cosmopolitanAPI = axios.create({
  baseURL: 'https://api.cosmopolitanusa.com/v1/',
  headers: { 'Authorization': `CosmoToken ${process.env.COSMOPOLITAN_API_KEY}` } 
});

async function fetchOpenShopifyOrders() {
  try {
    const response = await shopifyAPI.get('/orders.json', {
      params: {
        status: 'open',
        fields: 'id,email,note,shipping_address,line_items'
      }
    });
    console.log("Fetched orders:", response.data.orders);

    response.data.orders.forEach(order => {
      if (order.shipping_address) {
        console.log(`Order ID: ${order.id} Shipping Address:`, order.shipping_address);
      } else {
        console.log(`Order ID: ${order.id} has no shipping address.`);
      }
    });

    return response.data.orders;
  } catch (error) {
    console.error("Error fetching orders from Shopify:", error);
    throw error;
  }
}

async function checkSuborderExists(suborderId) {
  try {
    const response = await cosmopolitanAPI.get(`/suborders/${suborderId}`);
    return true; // Suborder exists
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.log(`Suborder ${suborderId} does not exist yet in Cosmopolitan.`);
      return false; // Suborder does not exist
    }
    console.error("Error checking suborder existence:", error.message);
    throw error;
  }
}



async function checkIfSuborderSubmitted(poNumber, suborderId) {
  try {
    const response = await cosmopolitanAPI.get(`/dropship/po/${poNumber}`);
    const suborders = response.data.Results;
    return suborders.some(suborder => suborder.Suborder === suborderId && suborder.Status === 'Processed');
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.log(`PO number ${poNumber} does not exist in Cosmopolitan.`);
      return false; // PO does not exist
    }
    console.error(`Error checking if suborder ${suborderId} has been submitted:`, error.message);
    throw error;
  }
}




async function logOrderIssue(orderDetails, issue) {
  // Add a note to the Shopify order
  const orderNote = `Order not processed due to inventory issue: ${issue}`;

  const updateData = {
    order: {
      id: orderDetails.id,
      note: orderDetails.note ? `${orderDetails.note}\n${orderNote}` : orderNote
    }
  };

  try {
    await shopifyAPI.put(`/orders/${orderDetails.id}.json`, updateData);
    console.log(`Added note to order ${orderDetails.id}: ${orderNote}`);
  } catch (error) {
    console.error(`Error adding note to Shopify order ${orderDetails.id}:`, error.message);
  }

  // Send email notification
  await sendEmailNotification(orderDetails, issue);
}

async function sendEmailNotification(orderDetails, issue) {
  const mailOptions = {
    from: process.env.GMAIL_USER,
    to: process.env.ADMIN_EMAIL,
    subject: `Inventory Issue with Order ${orderDetails.id}`,
    text: `There was an issue processing order ${orderDetails.id}. Reason: ${issue}`
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Email sent to ${process.env.ADMIN_EMAIL}`);
  } catch (error) {
    console.error('Error sending email:', error.message);
  }
}








async function submitOrderToCosmopolitan(orderDetails) {
  const { shipping_address: address, id, note, email, line_items } = orderDetails;

  if (!address || 
      !address.name || 
      !address.address1 || 
      !address.city || 
      !address.zip || 
      !address.province_code || 
      !address.country_code) {
    console.error("Order submission aborted due to incomplete shipping address:", address);
    return;  // Abort if essential shipping details are missing
  }

  const poNumber = id.toString();
  const suborderExists = await checkSuborderExists(poNumber);
  const suborderSubmitted = await checkIfSuborderSubmitted(poNumber, id.toString());

  if (suborderExists && suborderSubmitted) {
    console.log(`Suborder ${id.toString()} has already been submitted.`);
    return; // Exit if the suborder has already been submitted
  } else if (suborderExists && !suborderSubmitted) {
    console.log(`Suborder ${id.toString()} exists but has not been submitted. Submitting now.`);
    await submitDropshipOrder(id.toString());  // Ensure the dropship order is submitted if the suborder exists but wasn't submitted
    return;
  }

  const suborderLines = await Promise.all(line_items.map(async (item) => {
    const product = await fetchDetailedCosmopolitanProduct(item.sku);
    if (product && product.Available >= item.quantity) {
      return {
        SKU: item.sku,
        QTY: item.quantity,
        NET: item.price.toString(),
        ItemDesc: item.title || ""
      };
    } else {
      console.error(`Item ${item.sku} is out of stock or insufficient quantity.`);
      await logOrderIssue(orderDetails, `Item ${item.sku} is out of stock or insufficient quantity.`);
      return null;
    }
  }));

  const validLines = suborderLines.filter(line => line !== null);

  if (validLines.length === 0) {
    console.error("No valid lines to submit. All items are out of stock or insufficient quantity.");
    await logOrderIssue(orderDetails, "No valid lines to submit. All items are out of stock or insufficient quantity.");
    return;
  }

  const suborderData = {
    Suborder: id.toString(),
    Prime: false,
    Premium: false,
    Signature: false,
    Comment: note || "Dropship order from Shopify",
    ShipMethod: '',
    ShipTo: {
      Name: address.name,
      Line1: address.address1,
      Line2: address.address2 || "",
      City: address.city,
      State: address.province_code,
      Zip: address.zip,
      Country: address.country_code,
      Company: address.company || "",
      Phone: address.phone || "",
      Residence: true,
      Email: email || ""
    },
    Lines: validLines
  };

  console.log("Submitting order to Cosmopolitan with data:", JSON.stringify(suborderData, null, 2));

  try {
    const response = await cosmopolitanAPI.post('/suborders', suborderData);
    console.log("Order submitted to Cosmopolitan:", JSON.stringify(response.data, null, 2));
    if (response.data.Created === "FULLY" || response.data.Created === "PARTIALLY") {
      await submitDropshipOrder(id.toString());  // Submit the dropship order with the created suborder
    }
    return response.data;
  } catch (error) {
    console.error("Error submitting order to Cosmopolitan:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
    throw error;
  }
}



async function submitDropshipOrder(poNumber) {
  const dropshipData = {
    PO: poNumber,
    Comment: `Dropship order for PO# ${poNumber}`
  };

  console.log("Submitting dropship order with data:", JSON.stringify(dropshipData, null, 2));

  try {
    const response = await cosmopolitanAPI.post('/dropship', dropshipData);
    console.log("Dropship order submitted to Cosmopolitan:", response.data);
    return response.data;
  } catch (error) {
    console.error("Error submitting dropship order to Cosmopolitan:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
    throw error;
  }
}

async function retrieveTrackingInfo(poNumber) {
  try {
    const response = await cosmopolitanAPI.get(`/dropship/po/${poNumber}`);
    return response.data.Results.filter(suborder => suborder.Status === 'Processed');
  } catch (error) {
    console.error(`Error retrieving tracking info for PO ${poNumber}:`, error.message);
    throw error;
  }
}

async function retrieveOrderInfo(poNumber) {
  console.log(`Retrieving order info for PO number: ${poNumber}`);
  try {
    const response = await cosmopolitanAPI.get(`/dropship/po/${poNumber}`);
    const orders = response.data.Results;
    if (orders.length > 0) {
      const orderId = orders[0].Suborder; // Using Suborder instead of OrderID
      console.log(`Found Order ID: ${orderId} for PO number: ${poNumber}`);
      const orderResponse = await cosmopolitanAPI.get(`/dropship/suborder/${orderId}`);
      console.log(`Order info retrieved: ${JSON.stringify(orderResponse.data, null, 2)}`);
      return orderResponse.data;
    } else {
      throw new Error(`No orders found for PO ${poNumber}`);
    }
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.log(`PO number ${poNumber} does not exist.`);
      return null; 
    } else {
      console.error(`Error retrieving order info for PO ${poNumber}:`, error.message);
      return null; 
    }
  }
}


async function updateShopifyOrderWithTracking(orderId, trackingInfo) {
  console.log(`Updating Shopify order ${orderId} with tracking info:`, JSON.stringify(trackingInfo, null, 2));

  if (!trackingInfo.Shipments || trackingInfo.Shipments.length === 0) {
    console.error("Tracking info does not contain 'Shipments' property or it is empty.");
    return;
  }

  const shipment = trackingInfo.Shipments[0];

  // Fetch the fulfillment orders for the given Shopify order
  let fulfillmentOrderId;
  let fulfillmentLineitemIds;
  try {
    const fulfillmentDetails = await shopifyAPI.get(`/orders/${orderId}/fulfillment_orders.json`);
    console.log(`Fulfillment details: ${JSON.stringify(fulfillmentDetails.data, null, 2)}`);
    
    const openFulfillmentOrder = fulfillmentDetails.data.fulfillment_orders.find(order => order.status !== 'closed');
    
    if (!openFulfillmentOrder) {
      console.error(`No open fulfillment order found for Shopify order ${orderId}`);
      return;
    }

    fulfillmentOrderId = openFulfillmentOrder.id;
    fulfillmentLineitemIds = openFulfillmentOrder.line_items.map(item => ({
      id: item.id,
      quantity: item.quantity
    }));
  } catch (error) {
    console.error(`Error fetching fulfillment orders for Shopify order ${orderId}:`, error.message);
    return;
  }

  // Prepare the update parameters
  const updateParams = {
    fulfillment: {
      location_id: process.env.SHOPIFY_LOCATION_ID,
      tracking_info: {
        number: shipment.TrackingNumber,
        url: shipment.TrackingURL,
        company: shipment.Carrier
      },
      notify_customer: true,
      line_items_by_fulfillment_order: [
        {
          fulfillment_order_id: fulfillmentOrderId,
          fulfillment_order_line_items: fulfillmentLineitemIds
        }
      ],
    }
  };

  console.log(`Update parameters to be sent to Shopify: ${JSON.stringify(updateParams, null, 2)}`);

  // Send the update request to Shopify
  try {
    const response = await shopifyAPI.post(`/fulfillments.json`, updateParams);
    console.log(`Shopify order ${orderId} updated with tracking info:`, JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error(`Error updating Shopify order ${orderId} with tracking info:`, error.message);
    console.error(`Error details:`, error.response ? JSON.stringify(error.response.data, null, 2) : 'No response data');
    throw error;
  }
}



async function fetchAndSendRealOrder() {
  console.log("Fetching real orders and sending...");
  try {
    const orders = await fetchOpenShopifyOrders();
    for (let order of orders) {
      await submitOrderToCosmopolitan(order);

      // Retrieve order info and update Shopify with tracking info
      const orderInfo = await retrieveOrderInfo(order.id.toString());
      if (orderInfo) { // Only update if orderInfo is not null
        await updateShopifyOrderWithTracking(order.id, orderInfo);
      } else {
        console.log(`Skipping update for Shopify order ${order.id} due to missing order info.`);
      }
    }
    console.log("All open orders processed successfully.");
  } catch (error) {
    console.error("An error occurred during the real order processing:", error);
  }
}

fetchAndSendRealOrder();






async function fetchAllCosmopolitanProducts() {
  let allProducts = [];
  let nextPageUrl = 'https://api.cosmopolitanusa.com/v1/products';  // Start with the initial URL

  do {
      try {
        const response = await cosmopolitanAPI.get(nextPageUrl);
        const filteredProducts = response.data.Results.filter(product => product.Item && !product.Item.endsWith("-A"));
        allProducts = allProducts.concat(filteredProducts);
        nextPageUrl = response.data.NextUrl ? `https://${response.data.NextUrl}` : '';  // Prepare the next URL if it exists
      } catch (error) {
          console.error("Error fetching products:", error.message);
          break;  // Exit the loop if there's an error
      }
  } while (nextPageUrl);  // Continue as long as there's a next page URL available

  console.log(`Filtered products count: ${allProducts.length}`); // Log the number of products after filtering
  return allProducts;  // Return the full list of products
}



// Usage of the function
async function processProducts() {
  const products = await fetchAllCosmopolitanProducts();
  console.log(`Total products fetched: ${products.length}`);
  // Further processing can go here
}

processProducts();





async function fetchDetailedCosmopolitanProduct(itemCode) {
  try {
    const response = await cosmopolitanAPI.get(`/products/${itemCode}`, {
      headers: { 'Authorization': `CosmoToken ${process.env.COSMOPOLITAN_API_KEY}` }
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching details for product ${itemCode}:`, error);
    return null;
  }
}

async function findAllProducts() {
  let allProducts = [];
  let pageInfo = null;
  let lastRequestTime = Date.now();


  do {
    let url = `/products.json?fields=id,variants,images&limit=250`; 
    if (pageInfo) {
        url += `&page_info=${pageInfo}`;
    }

            // Calculate the time since the last request
    let timeSinceLastRequest = Date.now() - lastRequestTime;
    if (timeSinceLastRequest < 1000) { // Ensure at least 1 second between requests
        await new Promise(resolve => setTimeout(resolve, 1000 - timeSinceLastRequest));
    }


    try {
      const response = await shopifyAPI.get(url);
      allProducts = allProducts.concat(response.data.products);
      pageInfo = null; // Reset pageInfo after successful fetch
      const linkHeader = response.headers['link'];
      if (linkHeader) {
          const matches = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
          if (matches) {
              pageInfo = new URL(matches[1]).searchParams.get('page_info');
          }
      }
      lastRequestTime = Date.now(); // Update the last request time

    } catch (error) {
      console.error("Error encountered:", error);
      if (error.response && error.response.status === 429) {
        const retryAfter = error.response.headers['retry-after'] ? parseInt(error.response.headers['retry-after']) * 1000 : 1000;
        console.error(`Rate limit hit, retrying after ${retryAfter / 1000} seconds`);
        await new Promise(resolve => setTimeout(resolve, retryAfter));
      } else {
        break; // Exit the loop on non-retryable errors
      }
    }
  } while (pageInfo);
  return allProducts;
}





async function findShopifyProductBySKU(sku) {
  let allProducts = [];
  let pageInfo = null;
  let lastRequestTime = Date.now();

  do {
    let url = `/products.json?fields=id,variants&limit=250`;
    if (pageInfo) {
      url += `&page_info=${pageInfo}`;
    }

    let timeSinceLastRequest = Date.now() - lastRequestTime;
    if (timeSinceLastRequest < 1000) {
      await new Promise(resolve => setTimeout(resolve, 1000 - timeSinceLastRequest));
    }

    try {
      const response = await shopifyAPI.get(url);
      allProducts = allProducts.concat(response.data.products);
      pageInfo = null; // Reset pageInfo after successful fetch
      const linkHeader = response.headers['link'];
      if (linkHeader) {
        const matches = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (matches) {
          pageInfo = new URL(matches[1]).searchParams.get('page_info');
        }
      }
      lastRequestTime = Date.now(); // Update the last request time
    } catch (error) {
      console.error("Error encountered:", error);
      if (error.response && error.response.status === 429) {
        const retryAfter = error.response.headers['retry-after'] ? parseInt(error.response.headers['retry-after']) * 1000 : 1000;
        console.error(`Rate limit hit, retrying after ${retryAfter / 1000} seconds`);
        await new Promise(resolve => setTimeout(resolve, retryAfter));
      } else {
        break; // Exit the loop on non-retryable errors
      }
    }
  } while (pageInfo);

  for (let product of allProducts) {
    let variant = product.variants.find(v => v.sku === sku);
    if (variant) {
      return product;
    }
  }
  return null;
}




async function createOrUpdateShopifyProduct(detailedProductInfo, cosmopolitanSKUs) {
  const netPrice = parseFloat(detailedProductInfo.Net);
  let markupPercentage = 0;
  if (netPrice <= 24.99) markupPercentage = 30;
  else if (netPrice <= 50.00) markupPercentage = 25;
  else markupPercentage = 20;
  const finalPrice = Math.ceil((netPrice * (1 + markupPercentage / 100)) * 100) / 100;

  const retailPrice = parseFloat(detailedProductInfo.Retail);
  const compareAtPrice = retailPrice.toFixed(2);

  const fullDescription = `<strong>Description:</strong> ${detailedProductInfo.Desc}
    ${detailedProductInfo.Desc2 || ""}
    ${detailedProductInfo.Desc3 || ""}<br>
    <strong>UPC:</strong> ${detailedProductInfo.UPC}<br>
    <strong>Size:</strong> ${detailedProductInfo.Size}<br>
    <strong>Designer:</strong> ${detailedProductInfo.Designer}<br>
    <strong>Fragrance:</strong> ${detailedProductInfo.Fragrance}`;

// Initial data setup for a new product
  const productData = {
    product: {
      title: detailedProductInfo.Desc,
      body_html: fullDescription,
      vendor: "Cosmopolitan",
      product_type: detailedProductInfo.Product,
      tags: [
        detailedProductInfo.ProductLine ? `ProductLine_${detailedProductInfo.ProductLine}` : 'Unclassified',
        detailedProductInfo.ProductClass ? `ProductClass_${detailedProductInfo.ProductClass}` : 'Unclassified',
        `Designer_${detailedProductInfo.Designer}`,
        detailedProductInfo.Fragrance ? `Fragrance_${detailedProductInfo.Fragrance}` : 'No Fragrance'
      ],
      variants: [{
        price: finalPrice.toString(),
        compare_at_price: compareAtPrice,
        sku: detailedProductInfo.Item,
        inventory_quantity: detailedProductInfo.Available,
        inventory_management: 'shopify',
        weight: detailedProductInfo.Weight || '0',
        weight_unit: 'oz'
      }]
    }
  };

  try {
    const existingProduct = await findShopifyProductBySKU(detailedProductInfo.Item);
    if (existingProduct) {
      // Update the existing product
      delete productData.product.images;
      delete productData.product.title;
      delete productData.product.body_html;
      delete productData.product.tags;

      await shopifyAPI.put(`/products/${existingProduct.id}.json`, productData);
      console.log(`Updated product ${existingProduct.id} in Shopify.`);
    } else if (!cosmopolitanSKUs.has(detailedProductInfo.Item)) {
      // Draft the product if it does not exist in Cosmopolitan
      console.log(`Drafting product ${detailedProductInfo.Item} as it is no longer available on Cosmopolitan.`);
      await shopifyAPI.put(`/products/${existingProduct.id}.json`, { product: { status: 'draft' } });
    } else {
      // Before creating a new product, log and double-check the SKU
      console.error(`Product with SKU ${detailedProductInfo.Item} does not exist in Shopify, creating a new product.`);
      
      productData.product.images = detailedProductInfo.ImageURL ? [{ src: detailedProductInfo.ImageURL }] : [];
      const response = await shopifyAPI.post('/products.json', productData);
      console.log(`Created new product in Shopify: ${response.data.product.id}`);
    }
  } catch (error) {
    console.error(`Error creating or updating Shopify product: ${error.message}`);
    // Additional logging if a new product is created with an existing SKU
    if (error.response && error.response.data.errors && error.response.data.errors.sku) {
      console.error(`Attempted to create a product with an existing SKU: ${detailedProductInfo.Item}`);
    }
  }
}






async function processAllCosmopolitanProducts() {
  const products = await fetchAllCosmopolitanProducts(); 
  const cosmopolitanSKUs = new Set(products.map(product => product.Item)); // Fetch all Cosmopolitan SKUs

  for (const product of products) {
      const detailedProductInfo = await fetchDetailedCosmopolitanProduct(product.Item);

         // Check if the product SKU ends with '-A'
    if (product.Item.endsWith('-A')) {
      console.log(`Skipping product ${product.Item} because it ends with '-A'.`);
      continue;  // Skip the rest of the loop and move to the next product
    }
      
      if (detailedProductInfo && (detailedProductInfo.ProductLine !== 'Wellness' && detailedProductInfo.ProductLine !== 'Miscellaneous' && detailedProductInfo.ProductClass !== 'FGDLDY' && detailedProductInfo.ProductClass !== 'FGDUNX' && detailedProductInfo.ProductClass !== 'FGDMEN' && detailedProductInfo.ProductClass !== 'FGDCHD' && detailedProductInfo.ProductClass !== 'MINLDY' && detailedProductInfo.ProductClass !== 'MINUNX' && detailedProductInfo.ProductClass !== 'MINMEN' && detailedProductInfo.ProductClass !== 'BDDLDY' && detailedProductInfo.ProductClass !== 'BTDLDY' && detailedProductInfo.ProductClass !== 'BDDUNX' && detailedProductInfo.ProductClass !== 'BTDUNX' && detailedProductInfo.ProductClass !== 'SHVDMN' && detailedProductInfo.ProductClass !== 'BDDMEN' && detailedProductInfo.ProductClass !== 'BTDMEN' && detailedProductInfo.ProductClass !== 'BTDCHD' && detailedProductInfo.ProductClass !== 'BDDCHD' && detailedProductInfo.ProductClass !== 'DUODLDY' && detailedProductInfo.ProductClass !== 'DUODMEN' && detailedProductInfo.ProductClass !== 'STDLDY' && detailedProductInfo.ProductClass !== 'STDUNX' && detailedProductInfo.ProductClass !== 'STDMEN' && detailedProductInfo.ProductClass !== 'STDCHD' && detailedProductInfo.ProductClass !== 'MSDLDY' && detailedProductInfo.ProductClass !== 'MSDUNX' && detailedProductInfo.ProductClass !== 'MSDMEN' && detailedProductInfo.ProductClass !== 'SETDSKIN' && detailedProductInfo.ProductClass !== 'SETDMAKE' && detailedProductInfo.ProductClass !== 'SKIND' && detailedProductInfo.ProductClass !== 'SKINDMEN' && detailedProductInfo.ProductClass !== 'MAKED' && detailedProductInfo.ProductClass !== 'HAIRD' && detailedProductInfo.ProductClass !== 'HAIRDMEN')) {
        await createOrUpdateShopifyProduct(detailedProductInfo, cosmopolitanSKUs); // Pass the set of Cosmopolitan SKUs
      } else {
        console.log(`Skipping product ${product.Item} with ProductClass '${detailedProductInfo ? detailedProductInfo.ProductClass : "Unknown - Fetch Failed"}' or ProductLine '${detailedProductInfo ? detailedProductInfo.ProductLine : "Unknown - Fetch Failed"}'.`);
      }
  }
}






processAllCosmopolitanProducts().then(() => {
  console.log("Finished processing Cosmopolitan products.");
  console.log("Starting order processing test...");
}).then(() => {
  console.log("Test order processed successfully.");
}).catch(error => {
  console.error("An error occurred during processing:", error);
});

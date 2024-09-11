require('dotenv').config();
const axios = require('axios');
const nodemailer = require('nodemailer');
console.log("Script started");
const { fetchDetailedCosmopolitanProduct } = require('./productFunctions');


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
  


  async function fetchShopifyOrdersWithoutTracking() {
    try {
      const response = await shopifyAPI.get('/orders.json', {
        params: {
          status: 'any',
          fields: 'id,email,fulfillments'
        }
      });
      const ordersWithoutTracking = response.data.orders.filter(order => {
        return order.fulfillments.length === 0 || order.fulfillments.every(f => !f.tracking_number);
      });
      console.log("Fetched orders without tracking:", ordersWithoutTracking);
      return ordersWithoutTracking;
    } catch (error) {
      console.error("Error fetching orders without tracking from Shopify:", error);
      throw error;
    }
  }
  




  async function updateOrdersWithTrackingFromCosmopolitan() {
    try {
      const orders = await fetchShopifyOrdersWithoutTracking();
      for (let order of orders) {
        const orderInfo = await retrieveOrderInfo(order.id.toString());
        if (orderInfo) { // Only update if orderInfo is not null
          await updateShopifyOrderWithTracking(order.id, orderInfo);
        } else {
          console.log(`No tracking info found for Shopify order ${order.id} in Cosmopolitan.`);
        }
      }
      console.log("All orders without tracking processed successfully.");
    } catch (error) {
      console.error("An error occurred while updating orders with tracking:", error);
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
        if (orderInfo && orderInfo.Shipments && orderInfo.Shipments.length > 0) { // Ensure tracking info exists
          await updateShopifyOrderWithTracking(order.id, orderInfo);
        } else {
          console.log(`Skipping update for Shopify order ${order.id} due to missing tracking info.`);
        }
      }
      console.log("All open orders processed successfully.");
    } catch (error) {
      console.error("An error occurred during the real order processing:", error);
    }
  }
  


  module.exports = {
    fetchAndSendRealOrder,
    updateOrdersWithTrackingFromCosmopolitan
  };
  
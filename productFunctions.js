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
  console.log("Product Data", products)
  // Further processing can go here
}

processProducts();

async function fetchDetailedCosmopolitanProduct(itemCode) {
  const maxRetries = 3;  // Maximum number of retries
  const retryDelay = 2000;  // Initial delay between retries (in milliseconds)

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await cosmopolitanAPI.get(`/products/${itemCode}`, {
        headers: { 'Authorization': `CosmoToken ${process.env.COSMOPOLITAN_API_KEY}` }
      });
      return response.data;
    } catch (error) {
      if (attempt < maxRetries && (error.response?.status === 500 || error.response?.status === 503)) {
        console.warn(`Attempt ${attempt} failed for product ${itemCode}. Retrying in ${retryDelay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));  // Exponential backoff
      } else {
        console.error(`Error fetching details for product ${itemCode}:`, error.message);
        return null;  // Return null if all retries fail
      }
    }
  }
}

async function fetchAllShopifyProducts() {
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
      const linkHeader = response.headers['link'];
      if (linkHeader) {
        const matches = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (matches) {
          pageInfo = new URL(matches[1]).searchParams.get('page_info');
        } else {
          pageInfo = null;
        }
      } else {
        pageInfo = null;
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
      const linkHeader = response.headers['link'];
      if (linkHeader) {
        const matches = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (matches) {
          pageInfo = new URL(matches[1]).searchParams.get('page_info');
        } else {
          pageInfo = null;
        }
      } else {
        pageInfo = null;
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



async function createOrUpdateShopifyProduct(detailedProductInfo, cosmopolitanSKUs, shopifySKUs) {
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
    } else if (!shopifySKUs.has(detailedProductInfo.Item)) {
      // Create a new product only if it doesn't already exist in Shopify
      console.log(`Creating new product with SKU ${detailedProductInfo.Item} in Shopify.`);
      productData.product.images = detailedProductInfo.ImageURL ? [{ src: detailedProductInfo.ImageURL }] : [];
      const response = await shopifyAPI.post('/products.json', productData);
      console.log(`Created new product in Shopify: ${response.data.product.id}`);
    } else {
      console.log(`Product with SKU ${detailedProductInfo.Item} already exists in Shopify. Skipping creation.`);
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
  const allShopifyProducts = await fetchAllShopifyProducts();
  const shopifySKUs = new Set(allShopifyProducts.flatMap(product => product.variants.map(variant => variant.sku))); // Fetch all Shopify SKUs

  for (const product of products) {
    const detailedProductInfo = await fetchDetailedCosmopolitanProduct(product.Item);

    // Check if the product SKU ends with '-A'
    if (product.Item.endsWith('-A')) {
      console.log(`Skipping product ${product.Item} because it ends with '-A'.`);
      continue;  // Skip the rest of the loop and move to the next product
    }
    
    if (detailedProductInfo && (detailedProductInfo.ProductLine !== 'Wellness' && detailedProductInfo.ProductLine !== 'Miscellaneous' && detailedProductInfo.ProductClass !== 'FGDLDY' && detailedProductInfo.ProductClass !== 'FGDUNX' && detailedProductInfo.ProductClass !== 'FGDMEN' && detailedProductInfo.ProductClass !== 'FGDCHD' && detailedProductInfo.ProductClass !== 'MINLDY' && detailedProductInfo.ProductClass !== 'MINUNX' && detailedProductInfo.ProductClass !== 'MINMEN' && detailedProductInfo.ProductClass !== 'BDDLDY' && detailedProductInfo.ProductClass !== 'BTDLDY' && detailedProductInfo.ProductClass !== 'BDDUNX' && detailedProductInfo.ProductClass !== 'BTDUNX' && detailedProductInfo.ProductClass !== 'SHVDMN' && detailedProductInfo.ProductClass !== 'BDDMEN' && detailedProductInfo.ProductClass !== 'BTDMEN' && detailedProductInfo.ProductClass !== 'BTDCHD' && detailedProductInfo.ProductClass !== 'BDDCHD' && detailedProductInfo.ProductClass !== 'DUODLDY' && detailedProductInfo.ProductClass !== 'DUODMEN' && detailedProductInfo.ProductClass !== 'STDLDY' && detailedProductInfo.ProductClass !== 'STDUNX' && detailedProductInfo.ProductClass !== 'STDMEN' && detailedProductInfo.ProductClass !== 'STDCHD' && detailedProductInfo.ProductClass !== 'MSDLDY' && detailedProductInfo.ProductClass !== 'MSDUNX' && detailedProductInfo.ProductClass !== 'MSDMEN' && detailedProductInfo.ProductClass !== 'SETDSKIN' && detailedProductInfo.ProductClass !== 'SETDMAKE' && detailedProductInfo.ProductClass !== 'SKIND' && detailedProductInfo.ProductClass !== 'SKINDMEN' && detailedProductInfo.ProductClass !== 'MAKED' && detailedProductInfo.ProductClass !== 'HAIRD' && detailedProductInfo.ProductClass !== 'HAIRDMEN')) {
      await createOrUpdateShopifyProduct(detailedProductInfo, cosmopolitanSKUs, shopifySKUs); // Pass the set of Cosmopolitan SKUs
    } else {
      console.log(`Skipping product ${product.Item} with ProductClass '${detailedProductInfo ? detailedProductInfo.ProductClass : "Unknown - Fetch Failed"}' or ProductLine '${detailedProductInfo ? detailedProductInfo.ProductLine : "Unknown - Fetch Failed"}'.`);
    }
  }
}

module.exports = {
  processAllCosmopolitanProducts,
  fetchDetailedCosmopolitanProduct
};

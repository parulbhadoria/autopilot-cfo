import { getAccessToken, printError } from "../paypal/client.js";

try {
  const token = await getAccessToken();
  console.log("OK. Got sandbox access token:", token.slice(0, 12) + "...");
} catch (e) {
  printError(e);
  process.exit(1);
}

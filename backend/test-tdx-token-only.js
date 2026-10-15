import dotenv from "dotenv";

dotenv.config();

const url =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";

const clientId = process.env.TDX_CLIENT_ID;
const clientSecret = process.env.TDX_CLIENT_SECRET;

console.log("TDX_CLIENT_ID:", clientId ? `Loaded (${clientId.length} chars)` : "MISSING");
console.log(
  "TDX_CLIENT_SECRET:",
  clientSecret ? `Loaded (${clientSecret.length} chars)` : "MISSING"
);

const body = new URLSearchParams();
body.append("grant_type", "client_credentials");
body.append("client_id", clientId || "");
body.append("client_secret", clientSecret || "");

try {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await response.text();

  console.log();
  console.log("HTTP:", response.status);
  console.log("Content-Type:", response.headers.get("content-type"));

  if (response.ok) {
    const data = JSON.parse(text);

    console.log("✅ TOKEN OK");
    console.log("expires_in:", data.expires_in);
    console.log(
      "access_token:",
      data.access_token ? `${data.access_token.slice(0, 12)}...` : "MISSING"
    );
  } else {
    console.log("❌ TOKEN FAILED");
    console.log("BODY:", text.slice(0, 1000));
  }
} catch (error) {
  console.error("NETWORK ERROR:", error);
}

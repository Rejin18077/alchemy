require("dotenv").config();

const {
  Client,
  PrivateKey,
  TokenCreateTransaction,
  TokenType,
  TokenSupplyType,
} = require("@hashgraph/sdk");

async function main() {
  const client = Client.forTestnet();

  client.setOperator(
    process.env.HEDERA_ACCOUNT_ID,
    process.env.HEDERA_PRIVATE_KEY,
  );

  const tx = await new TokenCreateTransaction()
    .setTokenName("PUB TOKEN")
    .setTokenSymbol("PUB")
    .setTokenType(TokenType.FungibleCommon)
    .setDecimals(0)
    .setInitialSupply(1000)
    .setTreasuryAccountId(process.env.HEDERA_ACCOUNT_ID)
    .setSupplyType(TokenSupplyType.Infinite)
    .freezeWith(client)
    .sign(PrivateKey.fromString(process.env.HEDERA_PRIVATE_KEY));

  const submit = await tx.execute(client);
  const receipt = await submit.getReceipt(client);

  console.log("Token ID:", receipt.tokenId.toString());
}

main();

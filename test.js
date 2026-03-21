require("dotenv").config();

const { Client, TopicCreateTransaction } = require("@hashgraph/sdk");

async function main() {
  const client = Client.forTestnet();

  client.setOperator(
    process.env.HEDERA_ACCOUNT_ID,
    process.env.HEDERA_PRIVATE_KEY,
  );

  const tx = await new TopicCreateTransaction().execute(client);

  const receipt = await tx.getReceipt(client);

  console.log("Topic ID:", receipt.topicId.toString());
}

main();

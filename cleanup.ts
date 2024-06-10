import * as fs from "fs";

import { config } from "dotenv";
config();

import clerkClient from "@clerk/clerk-sdk-node";

const SECRET_KEY = process.env.CLERK_SECRET_KEY;

if (!SECRET_KEY) {
  throw new Error(
    "CLERK_SECRET_KEY is required. Please copy .env.example to .env and add your key."
  );
}

if (SECRET_KEY.split("_")[1] === "live") {
  throw new Error(
    "The Clerk Secret Key provided is for a development instance. Do not run cleanup in production!"
  );
}

const now = new Date().toISOString();

function appendLog(payload: any) {
  fs.appendFileSync(
    `./cleanup-log-${now}.json`,
    `\n${JSON.stringify(payload, null, 2)}`
  );
}

let usersDeleted = 0;

async function main() {
  const clerkUsers = await clerkClient.users.getUserList();

  console.log(`Found ${clerkUsers.length} to delete`);

  for (const clerkUser of clerkUsers) {
    console.log(`Deleting user ${clerkUser.id}`);
    try {
      await clerkClient.users.deleteUser(clerkUser.id);
      usersDeleted = usersDeleted + 1;
      appendLog({ userId: clerkUser.id, deleted: true });
    } catch (error) {
      appendLog({ userId: clerkUser.id, error, deleted: false });
      throw error;
    }
  }
}

main().then(() => {
  console.log(`${usersDeleted} users deleted`);
});

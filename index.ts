import { config } from "dotenv";
config();

import * as fs from "fs";
import * as z from "zod";
import clerkClient from "@clerk/clerk-sdk-node";
import ora, { Ora } from "ora";

enum HashingAlgorithms {
  argon2i = "argon2i",
  argon2id = "argon2id",
  bcrypt = "bcrypt",
  md5 = "md5",
  pbkdf2Sha256 = "pbkdf2_sha256",
  pbkdf2Sha256Django = "pbkdf2_sha256_django",
  pbkdf2Sha1 = "pbkdf2_sha1",
  scryptFirebase = "scrypt_firebase",
}

const hasherSchema = z.nativeEnum(HashingAlgorithms);

const SECRET_KEY = process.env.CLERK_SECRET_KEY;
const DELAY = parseInt(process.env.DELAY_MS ?? `1_000`);
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY_MS ?? `10_000`);
const IMPORT_TO_DEV = process.env.IMPORT_TO_DEV_INSTANCE ?? "false";
const OFFSET = parseInt(process.env.OFFSET ?? `0`);
const PASSWORD_HASHER = hasherSchema.parse(
  process.env.PASSWORD_HASHER ?? HashingAlgorithms.bcrypt
);

if (!SECRET_KEY) {
  throw new Error(
    "CLERK_SECRET_KEY is required. Please copy .env.example to .env and add your key."
  );
}

if (SECRET_KEY.split("_")[1] !== "live" && IMPORT_TO_DEV === "false") {
  throw new Error(
    "The Clerk Secret Key provided is for a development instance. Development instances are limited to 500 users and do not share their userbase with production instances. If you want to import users to your development instance, please set 'IMPORT_TO_DEV_INSTANCE' in your .env to 'true'."
  );
}

const userSchema = z.object({
  userId: z.string(),
  email: z.string().email(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  password: z.string().optional(),
  phoneNumber: z.array(z.string()).optional(),
});

type User = z.infer<typeof userSchema>;

const createUser = (userData: User) =>
  userData.password
    ? clerkClient.users.createUser({
        externalId: userData.userId,
        emailAddress: [userData.email],
        firstName: userData.firstName,
        lastName: userData.lastName,
        phoneNumber: userData.phoneNumber,
        passwordDigest: userData.password,
        passwordHasher: PASSWORD_HASHER,
      })
    : clerkClient.users.createUser({
        externalId: userData.userId,
        emailAddress: [userData.email],
        firstName: userData.firstName,
        lastName: userData.lastName,
        skipPasswordRequirement: true,
      });

const now = new Date().toISOString().split(".")[0]; // YYYY-MM-DDTHH:mm:ss
function appendLog(payload: any) {
  fs.appendFileSync(
    `./migration-log-${now}.json`,
    `\n${JSON.stringify(payload, null, 2)}`
  );
}

let migrated = 0;
let alreadyExists = 0;

async function processUserToClerk(userData: User, spinner: Ora) {
  const txt = spinner.text;
  try {
    const parsedUserData = userSchema.safeParse(userData);
    if (!parsedUserData.success) {
      throw parsedUserData.error;
    }
    await createUser(parsedUserData.data);

    migrated++;
  } catch (error) {
    if (error.status === 422) {
      appendLog({ userId: userData.userId, ...error });
      alreadyExists++;
      return;
    }

    // Keep cooldown in case rate limit is reached as a fallback if the thread blocking fails
    if (error.status === 429) {
      spinner.text = `${txt} - rate limit reached, waiting for ${RETRY_DELAY} ms`;
      await rateLimitCooldown();
      spinner.text = txt;
      return processUserToClerk(userData, spinner);
    }

    appendLog({ userId: userData.userId, ...error });
  }
}

async function cooldown() {
  await new Promise((r) => setTimeout(r, DELAY));
}

async function rateLimitCooldown() {
  await new Promise((r) => setTimeout(r, RETRY_DELAY));
}

async function main() {
  console.log(`Clerk User Migration Utility`);

  const inputFileName = process.argv[2] ?? "users.json";
  const phoneInputFileName = process.argv[3] ?? "users-phone-numbers.json";

  console.log(`Fetching users from ${inputFileName}`);

  const parsedUserData: any[] = JSON.parse(
    fs.readFileSync(inputFileName, "utf-8")
  );
  const parsedUserPhoneNumbers: any[] = JSON.parse(
    fs.readFileSync(phoneInputFileName, "utf-8")
  );

  const parsedUsersWithPhoneNumbers: User[] = parsedUserData.map((user) => {
    const userWithPhoneNumber = parsedUserPhoneNumbers.find(
      (userPhoneNumber) => userPhoneNumber.id === user.userId
    );

    if (!userWithPhoneNumber?.phone) {
      return user;
    }

    return {
      ...user,
      phoneNumber: [String(userWithPhoneNumber.phone)],
    };
  });

  const offsetUsers = parsedUsersWithPhoneNumbers.slice(OFFSET);
  console.log(
    `${inputFileName} and ${phoneInputFileName} found and parsed, attempting migration with an offset of ${OFFSET}`
  );

  let i = 0;
  const spinner = ora(`Migrating users`).start();

  for (const userData of offsetUsers) {
    spinner.text = `Migrating user ${i}/${offsetUsers.length}, cooldown`;
    await cooldown();
    i++;
    spinner.text = `Migrating user ${i}/${offsetUsers.length}`;
    await processUserToClerk(userData, spinner);
  }

  spinner.succeed(`Migration complete`);
  return;
}

main().then(() => {
  console.log(`${migrated} users migrated`);
  console.log(`${alreadyExists} users failed to upload`);
});

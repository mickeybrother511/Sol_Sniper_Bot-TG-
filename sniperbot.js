import TelegramBot from "node-telegram-bot-api";
import {
  Connection,
  PublicKey,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import fetch from "node-fetch";
import fs from "fs";
import config from "./config.js";
import { toArray } from "./utils.js";
import bs58 from "bs58";
// Initialize Telegram Bot
const BOT_TOKEN = "7831268431:AAEuk0QqdtzCdA-lUQhBZ1R4CLQYhu1iR-s"; // Replace with your bot token
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Function to convert Base58 private key to Uint8Array
function toUint8Array(base58String) {
  const decodedBytes = bs58.decode(base58String);
  return new Uint8Array(decodedBytes);
}
const privateKeyBase58 = config.PRIVATEKEY;
const secretKey = toUint8Array(privateKeyBase58);
// Solana Configuration
const connection = new Connection(config.HTTPURL, {
  wsEndpoint: config.WSSURL,
});
const RAYDIUMPROGRAMID = new PublicKey(config.RAYDIUMPUBLICKEY);
const NATIVETOKEN = config.NATIVETOKEN;
const wallet = Keypair.fromSecretKey(secretKey);
let sniperRunning = false;

/**
 * Check if a user is whitelisted
 */
function isWhitelisted(userId) {
  return config.WHITELISTEDUSERS.includes(userId);
}

/**~
 * Save the updated config to the file
 */
function saveConfig() {
  fs.writeFileSync(
    "./config.js",
    `const config = ${JSON.stringify(
      config,
      null,
      2
    )};\n\nexport default config;`
  );
}

bot.onText(/\/start/, async (msg) => {
  if (!isWhitelisted(msg.from.id))
    return bot.sendMessage(
      msg.chat.id,
      "You are not authorized to use this bot."
    );

  try {
    // Get the wallet's public key
    const publicKey = wallet.publicKey.toString();

    // Get the balance of the wallet
    const balance = await connection.getBalance(wallet.publicKey);

    bot.sendMessage(
      msg.chat.id,
      `
Welcome to the Sniper Bot! Use /help for available commands.

<b>Wallet Details:</b>
- <b>Address:</b> <code>${publicKey}</code>
- <b>Balance:</b> ${balance / 1e9} SOL
      `,
      { parse_mode: "HTML" }
    );
  } catch (error) {
    console.error("Error fetching wallet details:", error);
    bot.sendMessage(
      msg.chat.id,
      "Error fetching wallet details. Please try again."
    );
  }
});

bot.onText(/\/help/, (msg) => {
  if (!isWhitelisted(msg.from.id))
    return bot.sendMessage(
      msg.chat.id,
      "You are not authorized to use this bot."
    );

  bot.sendMessage(
    msg.chat.id,
    `
Available Commands:
/start - Start the bot
/help - List commands
/start_sniper - Start the sniper bot
/stop_sniper - Stop the sniper bot
/config - View current config
/whitelist_add userId - Add a user to whitelist
/whitelist_remove userId - Remove a user from whitelist
`
  );
});

/**
 * Render user-readable config
 */
function renderConfig() {
  return `
<b>Current Configuration:</b>
- Observe Only: <code>${config.OBSERVEONLY}</code>
- Buy Amount: <code>${config.BUYAMOUNT}</code>
- Slippage: <code>${config.SLIPPAGE}</code>
- Stop Loss: <code>${config.STOPLOSS}</code>
- Take Profit: <code>${config.TAKEPROFIT}</code>
- Whitelisted Users: <code>${config.WHITELISTEDUSERS.join(", ")}</code>
`;
}

/**
 * Start monitoring the specified program for logs
 */
async function startSniper(chatId) {
  if (sniperRunning) {
    bot.sendMessage(chatId, "Sniper bot is already running!");
    return;
  }

  sniperRunning = true;
  bot.sendMessage(
    chatId,
    `Monitoring Raydium pools... Mode: ${
      config.OBSERVEONLY ? "Observe Only" : "Buy"
    }`
  );

  connection.onLogs(
    RAYDIUMPROGRAMID,
    async ({ logs, signature }) => {
      if (!sniperRunning) return;

      if (logs.some((log) => log.includes("initialize2"))) {
        bot.sendMessage(
          chatId,
          `New pool detected: https://explorer.solana.com/tx/${signature}`
        );
        const token = await fetchRaydiumMints(signature);
        if (token && !config.OBSERVEONLY) {
          await executeSwap(token, chatId);
        }
      }
    },
    "finalized"
  );
}

/**
 * Fetch the token mints involved in the Raydium transaction
 */
async function fetchRaydiumMints(txId) {
  try {
    const tx = await connection.getParsedTransaction(txId, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });

    const accounts = tx?.transaction.message.instructions.find(
      (ix) => ix.programId.toBase58() === config.RAYDIUMPUBLICKEY
    )?.accounts;

    if (!accounts) return null;

    const tokenAAccount = accounts[8];
    const tokenBAccount = accounts[9];

    return tokenAAccount.toBase58() === NATIVETOKEN
      ? tokenBAccount.toBase58()
      : tokenAAccount.toBase58();
  } catch (error) {
    console.error("Error fetching transaction details:", error);
    return null;
  }
}

/**
 * Execute a swap transaction
 */
async function executeSwap(outputMint, chatId) {
  try {
    const inputMint = NATIVETOKEN;
    const amount = config.BUYAMOUNT;
    const slippageBps = config.SLIPPAGE;

    const quoteResponse = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`
    ).then((res) => res.json());

    console.log(quoteResponse);

    if (!quoteResponse?.routePlan?.length) {
      bot.sendMessage(chatId, "No swap routes available.");
      return;
    }

    bot.sendMessage(chatId, "Executing swap...");
    await executeSwapTransaction(quoteResponse, chatId);
    await monitorPriceAndSell(outputMint, quoteResponse.outAmount, chatId);
  } catch (error) {
    bot.sendMessage(chatId, `Error during swap: ${error.message}`);
    console.error("Error during swap execution:", error);
  }
}

/**
 * Execute Jupiter API swap transaction
 */
async function executeSwapTransaction(quoteResponse, chatId) {
  try {
    const { swapTransaction } = await fetch(
      "https://quote-api.jup.ag/v6/swap",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
        }),
      }
    ).then((res) => res.json());

    const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    transaction.sign([wallet]);
    const txId = await connection.sendRawTransaction(transaction.serialize());
    bot.sendMessage(
      chatId,
      `Swap completed: https://explorer.solana.com/tx/${txId}`
    );
  } catch (error) {
    bot.sendMessage(
      chatId,
      `Error executing swap transaction: ${error.message}`
    );
    console.error("Error executing swap transaction:", error);
  }
}

async function monitorPriceAndSell(token, amount, chatId) {
  const outputMint = NATIVETOKEN;
  const slippageBps = config.SLIPPAGE;

  const interval = setInterval(async () => {
    try {
      const quoteResponse = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${token}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`
      ).then((res) => res.json());

      if (!quoteResponse?.outAmount) {
        console.log("Error fetching quote response.");
        return;
      }

      const outAmount = quoteResponse.outAmount;
      if (outAmount <= (config.STOPLOSS / 100) * amount) {
        bot.sendMessage(chatId, "SELLING TO STOP LOSS...");
        await executeSwapTransaction(quoteResponse);
        clearInterval(interval);
      }

      if (outAmount >= (config.TAKEPROFIT / 100) * amount) {
        bot.sendMessage(chatId, "SELLING TO TAKE PROFIT...");
        await executeSwapTransaction(quoteResponse);
        clearInterval(interval);
      }
    } catch (error) {
      console.error("Error monitoring price:", error);
    }
  }, 1000);
}

/**
 * Telegram Bot Commands
 */
bot.onText(/\/start_sniper/, (msg) => {
  if (!isWhitelisted(msg.from.id))
    return bot.sendMessage(
      msg.chat.id,
      "You are not authorized to use this bot."
    );

  const chatId = msg.chat.id;
  startSniper(chatId);
});

bot.onText(/\/stop_sniper/, (msg) => {
  if (!isWhitelisted(msg.from.id))
    return bot.sendMessage(
      msg.chat.id,
      "You are not authorized to use this bot."
    );

  const chatId = msg.chat.id;
  if (!sniperRunning) {
    bot.sendMessage(chatId, "Sniper bot is not running.");
    return;
  }
  sniperRunning = false;
  bot.sendMessage(chatId, "Sniper bot stopped.");
});

bot.onText(/\/config/, (msg) => {
  if (!isWhitelisted(msg.from.id))
    return bot.sendMessage(
      msg.chat.id,
      "You are not authorized to use this bot."
    );

  const chatId = msg.chat.id;
  bot.sendMessage(chatId, renderConfig(), {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Toggle Observe Only", callback_data: "toggle_OBSERVEONLY" },
          { text: "Set Buy Amount", callback_data: "set_BUYAMOUNT" },
        ],
        [
          { text: "Set Slippage", callback_data: "set_SLIPPAGE" },
          { text: "Set Stop Loss", callback_data: "set_STOPLOSS" },
        ],
        [{ text: "Set Take Profit", callback_data: "set_TAKEPROFIT" }],
      ],
    },
  });
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith("toggle")) {
    const key = data.split("_")[1];
    config[key] = !config[key];
    saveConfig();
    bot.sendMessage(chatId, `${key} updated: ${config[key]}`);
  }

  if (data.startsWith("set")) {
    const key = data.split("_")[1];
    bot.sendMessage(chatId, `Send me the new value for ${key}.`);
    bot.once("message", (msg) => {
      const value = parseFloat(msg.text);
      if (!isNaN(value)) {
        if (key == "PRIVATEKEY") {
          config[key] = toArray(value);
        } else {
          config[key] = value;
        }
        saveConfig();
        bot.sendMessage(chatId, `${key} updated: ${config[key]}`);
      } else {
        bot.sendMessage(chatId, "Invalid value. Update cancelled.");
      }
    });
  }
});

bot.onText(/\/whitelist_add (\d+)/, (msg, match) => {
  if (!isWhitelisted(msg.from.id))
    return bot.sendMessage(
      msg.chat.id,
      "You are not authorized to use this bot."
    );

  const userId = parseInt(match[1]);
  if (!config.WHITELISTEDUSERS.includes(userId)) {
    config.WHITELISTEDUSERS.push(userId);
    saveConfig();
    bot.sendMessage(msg.chat.id, `User ${userId} added to whitelist.`);
  } else {
    bot.sendMessage(msg.chat.id, `User ${userId} is already whitelisted.`);
  }
});

bot.onText(/\/whitelist_remove (\d+)/, (msg, match) => {
  if (!isWhitelisted(msg.from.id))
    return bot.sendMessage(
      msg.chat.id,
      "You are not authorized to use this bot."
    );

  const userId = parseInt(match[1]);
  const index = config.WHITELISTEDUSERS.indexOf(userId);
  if (index !== -1) {
    config.WHITELISTEDUSERS.splice(index, 1);
    saveConfig();
    bot.sendMessage(msg.chat.id, `User ${userId} removed from whitelist.`);
  } else {
    bot.sendMessage(msg.chat.id, `User ${userId} is not in the whitelist.`);
  }
});

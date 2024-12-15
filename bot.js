import {
    Connection,
    PublicKey,
    Keypair,
    Transaction,
    VersionedTransaction,
  } from "@solana/web3.js";
  import fetch from "node-fetch";
  import config from "./config.js";
  
  const connection = new Connection(config.HTTP_URL, {
    wsEndpoint: config.WSS_URL,
  });
  
  const RAYDIUM_PROGRAM_ID = new PublicKey(config.RAYDIUM_PUBLIC_KEY);
  const NATIVE_TOKEN = config.NATIVE_TOKEN;
  const INSTRUCTION_NAME = "initialize2"; // Instruction to monitor
  const wallet = Keypair.fromSecretKey(config.PRIVATE_KEY);
  
  /**
   * Start monitoring the specified program for logs
   */
  async function startConnection(connection, programAddress, searchInstruction) {
    console.log(
      `Monitoring logs for program: ${programAddress.toString()}, Mode: ${
        config.OBSERVE_ONLY ? "Observe Only" : "Buy"
      }`
    );
  
    connection.onLogs(
      programAddress,
      async ({ logs, err, signature }) => {
        if (err) return;
  
        if (logs && logs.some((log) => log.includes(searchInstruction))) {
          console.log(
            "Signature for 'initialize2':",
            `https://explorer.solana.com/tx/${signature}`
          );
          const token = await fetchRaydiumMints(signature);
          if (token && !config.OBSERVE_ONLY) {
            await executeSwap(token);
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
        (ix) => ix.programId.toBase58() === config.RAYDIUM_PUBLIC_KEY
      )?.accounts;
  
      if (!accounts) {
        console.log("No accounts found in the transaction.");
        return null;
      }
  
      const tokenAIndex = 8;
      const tokenBIndex = 9;
      const tokenAAccount = accounts[tokenAIndex];
      const tokenBAccount = accounts[tokenBIndex];
  
      console.log("New LP Found:");
      console.table([
        { Token: "A", "Account Public Key": tokenAAccount.toBase58() },
        { Token: "B", "Account Public Key": tokenBAccount.toBase58() },
      ]);
  
      return tokenAAccount.toBase58() === NATIVE_TOKEN
        ? tokenBAccount.toBase58()
        : tokenAAccount.toBase58();
    } catch (error) {
      console.error("Error fetching transaction details:", error);
      return null;
    }
  }
  
  /**
   * Monitor token price and execute a sell transaction on stop-loss or take-profit
   */
  async function monitorPriceAndSell(token, amount) {
    const outputMint = NATIVE_TOKEN;
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
        if (outAmount <= (config.STOP_LOSS / 100) * amount) {
          console.log("SELLING TO STOP LOSS...");
          await executeSwapTransaction(quoteResponse);
          clearInterval(interval);
        }
  
        if (outAmount >= (config.TAKE_PROFIT / 100) * amount) {
          console.log("SELLING TO TAKE PROFIT...");
          await executeSwapTransaction(quoteResponse);
          clearInterval(interval);
        }
      } catch (error) {
        console.error("Error monitoring price:", error);
      }
    }, 1000);
  }
  
  /**
   * Execute a swap transaction
   */
  async function executeSwap(outputMint) {
    try {
      const inputMint = NATIVE_TOKEN;
      const amount = config.BUY_AMOUNT;
      const slippageBps = config.SLIPPAGE;
  
      const quoteResponse = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`
      ).then((res) => res.json());
  
      if (!quoteResponse?.routePlan?.length) {
        console.log("No swap routes available.");
        return;
      }
  
      console.log("Executing buy...");
      await executeSwapTransaction(quoteResponse);
      await monitorPriceAndSell(outputMint, quoteResponse.outAmount);
    } catch (error) {
      console.error("Error during swap execution:", error);
    }
  }
  
  /**
   * Handle Jupiter API swap transactions
   */
  async function executeSwapTransaction(quoteResponse) {
    try {
      const { swapTransaction } = await fetch("https://quote-api.jup.ag/v6/swap", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
        }),
      }).then((res) => res.json());
  
      const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  
      transaction.sign([wallet]);
      const txId = await connection.sendRawTransaction(transaction.serialize());
      console.log(`Swap transaction sent: https://explorer.solana.com/tx/${txId}`);
    } catch (error) {
      console.error("Error executing swap transaction:", error);
    }
  }
  
  // Start monitoring Raydium pools
  startConnection(connection, RAYDIUM_PROGRAM_ID, INSTRUCTION_NAME).catch(console.error);
  
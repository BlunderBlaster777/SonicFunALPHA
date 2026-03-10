// ---------------------------
// CONFIG
// ---------------------------
const CONTRACT_ADDRESS = "0x76baA0327Ff80cf04AFBE282AE462bd810e99337"; // <-- set this
const ABI_JSON_PATH = "ABI.json";
const USDC_DECIMALS = 6;
const POLL_INTERVAL = 5000;
const MAX_APPROVE = ethers.constants.MaxUint256;

// ---------------------------
// STATE
// ---------------------------
let provider;
let signer;
let contract;
let account;
let currentMarketId = null;
let marketPollHandle = null;
let CONTRACT_ABI = null;
let usdcContract = null;
let usdcAddress = null;

// Minimal ERC20 ABI for allowance/approve/decimals/name/symbol
const ERC20_ABI = [
  { "constant":true,"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],"type":"function" },
  { "constant":true,"inputs":[],"name":"symbol","outputs":[{"name":"","type":"string"}],"type":"function" },
  { "constant":true,"inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"}],"name":"allowance","outputs":[{"name":"","type":"uint256"}],"type":"function" },
  { "constant":false,"inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],"name":"approve","outputs":[{"name":"","type":"bool"}],"type":"function" },
  { "constant":true,"inputs":[{"name":"account","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"type":"function" }
];

// ---------------------------
// HELPERS
// ---------------------------
function log(msg) {
  const el = document.getElementById("log");
  const time = new Date().toLocaleTimeString();
  el.innerText = `[${time}] ${msg}\n` + el.innerText;
}

function showError(err) {
  console.error(err);
  const message = err && err.message ? err.message : String(err);
  log("Error: " + message);
  alert("Error: " + message);
}

function safeGetNumber(bn) {
  try {
    if (bn === undefined || bn === null) return 0;
    if (bn.toNumber) return bn.toNumber();
    return Number(bn);
  } catch {
    return Number(bn.toString());
  }
}

function formatUSDC(amountBN) {
  try {
    const asString = amountBN.toString();
    const bn = ethers.BigNumber.from(asString);
    const whole = bn.div(ethers.BigNumber.from(10).pow(USDC_DECIMALS)).toString();
    const frac = bn.mod(ethers.BigNumber.from(10).pow(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, "0");
    const display = `${whole}.${frac.slice(0,2)}`;
    return `${display} USDC`;
  } catch (e) {
    return String(amountBN);
  }
}

function formatPriceX18(bn) {
  try {
    const asString = bn.toString();
    const big = ethers.BigNumber.from(asString);
    const whole = big.div(ethers.BigNumber.from("1000000000000000000")).toString();
    const frac = big.mod(ethers.BigNumber.from("1000000000000000000")).toString().padStart(18,"0");
    return `${whole}.${frac.slice(0,6)}`;
  } catch {
    return String(bn);
  }
}

function toChecksum(address) {
  try {
    return ethers.utils.getAddress(address);
  } catch {
    return null;
  }
}

function formatSeconds(s) {
  const mm = Math.floor(s / 60).toString().padStart(2, "0");
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

// ---------------------------
// UI BINDINGS
// ---------------------------
document.getElementById("connectBtn").addEventListener("click", connectWallet);
document.getElementById("betUpBtn").addEventListener("click", () => placeBet(true));
document.getElementById("betDownBtn").addEventListener("click", () => placeBet(false));
document.getElementById("claimBtn").addEventListener("click", claim);
document.getElementById("resolveBtn").addEventListener("click", resolveMarket);
document.getElementById("createBtn").addEventListener("click", createMarket);
document.getElementById("approveBtn").addEventListener("click", approveUSDC);
document.getElementById("approveMaxBtn").addEventListener("click", approveMaxUSDC);

// ---------------------------
// BOOTSTRAP: load ABI then enable UI
// ---------------------------
(async function bootstrap() {
  try {
    const res = await fetch(ABI_JSON_PATH);
    if (!res.ok) throw new Error("Failed to load ABI.json. Put ABI.json in same folder.");
    CONTRACT_ABI = await res.json();
    log("ABI loaded.");
  } catch (err) {
    showError(err);
  }
})();

// ---------------------------
// CONNECT WALLET
// ---------------------------
async function connectWallet() {
  try {
    if (!window.ethereum) throw new Error("No injected wallet found (MetaMask).");

    provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    await provider.send("eth_requestAccounts", []);
    signer = provider.getSigner();
    account = await signer.getAddress();
    document.getElementById("walletAddress").innerText = account;
    log("Wallet connected: " + account);

    const checksum = toChecksum(CONTRACT_ADDRESS);
    if (!checksum) throw new Error("Invalid contract address. Set CONTRACT_ADDRESS in script.js");

    if (!CONTRACT_ABI) throw new Error("ABI not loaded yet. Ensure ABI.json is present and valid.");

    contract = new ethers.Contract(checksum, CONTRACT_ABI, signer);

    // load USDC token address from contract and create ERC20 instance
    try {
      usdcAddress = await contract.tokenBet();
      usdcAddress = toChecksum(usdcAddress);
      document.getElementById("usdcAddress").innerText = usdcAddress;
      usdcContract = new ethers.Contract(usdcAddress, ERC20_ABI, signer);
      log("USDC token loaded: " + usdcAddress);
      await refreshAllowance();
    } catch (e) {
      log("Could not load tokenBet from contract: " + (e.message || e));
    }

    await loadMarketOnce();
    if (marketPollHandle) clearInterval(marketPollHandle);
    marketPollHandle = setInterval(loadMarketOnce, POLL_INTERVAL);

    window.ethereum.on && window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on && window.ethereum.on("chainChanged", handleChainChanged);

  } catch (err) {
    showError(err);
  }
}

async function handleAccountsChanged(accounts) {
  if (!accounts || accounts.length === 0) {
    account = null;
    document.getElementById("walletAddress").innerText = "Not connected";
    log("Wallet disconnected");
    return;
  }
  account = accounts[0];
  document.getElementById("walletAddress").innerText = account;
  log("Account changed: " + account);
  signer = provider.getSigner();
  contract = new ethers.Contract(toChecksum(CONTRACT_ADDRESS), CONTRACT_ABI, signer);
  if (usdcAddress) usdcContract = new ethers.Contract(usdcAddress, ERC20_ABI, signer);
  await loadMarketOnce();
}

async function handleChainChanged(_chainId) {
  provider = new ethers.providers.Web3Provider(window.ethereum, "any");
  signer = provider.getSigner();
  contract = new ethers.Contract(toChecksum(CONTRACT_ADDRESS), CONTRACT_ABI, signer);
  if (usdcAddress) usdcContract = new ethers.Contract(usdcAddress, ERC20_ABI, signer);
  log("Chain changed: " + _chainId);
  await loadMarketOnce();
}

// ---------------------------
// ALLOWANCE / APPROVE
// ---------------------------
async function refreshAllowance() {
  try {
    if (!usdcContract || !account) return;
    const allowanceBN = await usdcContract.allowance(account, toChecksum(CONTRACT_ADDRESS));
    document.getElementById("allowance").innerText = formatUSDC(allowanceBN);
    return allowanceBN;
  } catch (err) {
    log("Could not read allowance: " + (err.message || err));
    document.getElementById("allowance").innerText = "-";
  }
}

async function approveUSDC() {
  try {
    if (!usdcContract) throw new Error("USDC contract not loaded.");
    const raw = document.getElementById("approveAmount").value;
    if (!raw || Number(raw) <= 0) throw new Error("Enter an approve amount.");
    const amount = ethers.utils.parseUnits(String(raw), USDC_DECIMALS);
    const tx = await usdcContract.approve(toChecksum(CONTRACT_ADDRESS), amount);
    log(`Approve tx sent: ${tx.hash}`);
    await tx.wait();
    log("Approve confirmed.");
    await refreshAllowance();
  } catch (err) {
    showError(err);
  }
}

async function approveMaxUSDC() {
  try {
    if (!usdcContract) throw new Error("USDC contract not loaded.");
    const tx = await usdcContract.approve(toChecksum(CONTRACT_ADDRESS), MAX_APPROVE);
    log(`Approve(max) tx sent: ${tx.hash}`);
    await tx.wait();
    log("Approve(max) confirmed.");
    await refreshAllowance();
  } catch (err) {
    showError(err);
  }
}

// ---------------------------
// MARKET LOADING
// ---------------------------
async function loadMarketOnce() {
  try {
    if (!contract) return;

    const nextIdBN = await contract.nextMarketId();
    const nextId = safeGetNumber(nextIdBN);
    const id = nextId - 1;

    if (id < 0) {
      currentMarketId = null;
      document.getElementById("marketId").innerText = "-";
      document.getElementById("startPrice").innerText = "-";
      document.getElementById("endTime").innerText = "-";
      document.getElementById("upPool").innerText = "-";
      document.getElementById("downPool").innerText = "-";
      document.getElementById("status").innerText = "No market created";
      document.getElementById("countdown").innerText = "";
      log("No market exists yet.");
      return;
    }

    currentMarketId = id;
    document.getElementById("marketId").innerText = id;

    const m = await contract.markets(id);

    document.getElementById("startPrice").innerText = formatPriceX18(m.startPrice);
    document.getElementById("endTime").innerText = m.endTime.toNumber ? new Date(m.endTime.toNumber() * 1000).toLocaleString() : new Date(Number(m.endTime) * 1000).toLocaleString();
    document.getElementById("upPool").innerText = formatUSDC(m.upPool);
    document.getElementById("downPool").innerText = formatUSDC(m.downPool);
    document.getElementById("status").innerText = m.resolved ? "Resolved" : "Active";

    if (!m.resolved) {
      const now = Math.floor(Date.now() / 1000);
      const endTs = m.endTime.toNumber ? m.endTime.toNumber() : Number(m.endTime);
      const secs = Math.max(0, endTs - now);
      document.getElementById("countdown").innerText = `Time left: ${formatSeconds(secs)}`;
    } else {
      document.getElementById("countdown").innerText = "";
    }

    // refresh allowance display if possible
    await refreshAllowance();

  } catch (err) {
    if (err && err.code === "UNSUPPORTED_OPERATION" && /ENS/i.test(err.message)) {
      log("Network does not support ENS; continuing without ENS resolution.");
      try {
        contract = new ethers.Contract(toChecksum(CONTRACT_ADDRESS), CONTRACT_ABI, signer || provider);
        await loadMarketOnce();
      } catch (e) {
        showError(e);
      }
      return;
    }
    showError(err);
  }
}

// ---------------------------
// ACTIONS: bets, claim, resolve, create
// ---------------------------
async function placeBet(isUp) {
  try {
    if (!contract) throw new Error("Connect wallet first.");
    if (currentMarketId === null) throw new Error("No active market.");

    const raw = document.getElementById("betAmount").value;
    if (!raw || Number(raw) <= 0) throw new Error("Enter a bet amount.");
    if (Number(raw) < 0.5) throw new Error("Minimum bet is 0.5 USDC.");

    const usdcAmount = ethers.utils.parseUnits(String(raw), USDC_DECIMALS);

    // check allowance
    if (!usdcContract) {
      // try to load tokenBet if not loaded
      try {
        usdcAddress = await contract.tokenBet();
        usdcAddress = toChecksum(usdcAddress);
        usdcContract = new ethers.Contract(usdcAddress, ERC20_ABI, signer);
        document.getElementById("usdcAddress").innerText = usdcAddress;
      } catch (e) {
        log("Could not load USDC token: " + (e.message || e));
      }
    }

    if (usdcContract) {
      const allowanceBN = await usdcContract.allowance(account, toChecksum(CONTRACT_ADDRESS));
      if (ethers.BigNumber.from(allowanceBN).lt(usdcAmount)) {
        throw new Error("Insufficient allowance. Please approve USDC first.");
      }
    } else {
      log("Warning: USDC contract not available; proceeding (may fail).");
    }

    const tx = await contract[isUp ? "betUp" : "betDown"](currentMarketId, usdcAmount);
    log(`Sent bet tx: ${tx.hash}`);
    await tx.wait();
    log("Bet confirmed.");
    await loadMarketOnce();
  } catch (err) {
    showError(err);
  }
}

async function claim() {
  try {
    if (!contract) throw new Error("Connect wallet first.");
    if (currentMarketId === null) throw new Error("No market to claim.");

    const tx = await contract.claim(currentMarketId);
    log(`Claim tx: ${tx.hash}`);
    await tx.wait();
    log("Claim confirmed.");
    await loadMarketOnce();
  } catch (err) {
    showError(err);
  }
}

async function resolveMarket() {
  try {
    if (!contract) throw new Error("Connect wallet first.");
    if (currentMarketId === null) throw new Error("No market to resolve.");

    const tx = await contract.resolveMarket(currentMarketId);
    log(`Resolve tx: ${tx.hash}`);
    await tx.wait();
    log("Market resolved (owner).");
    setTimeout(loadMarketOnce, 2000);
  } catch (err) {
    showError(err);
  }
}

async function createMarket() {
  try {
    if (!contract) throw new Error("Connect wallet first.");
    const tx = await contract.createMarket();
    log(`Create tx: ${tx.hash}`);
    await tx.wait();
    log("Market created (owner).");
    setTimeout(loadMarketOnce, 2000);
  } catch (err) {
    showError(err);
  }
}

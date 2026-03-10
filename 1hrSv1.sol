// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IRamsesV3Pool {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function token0() external view returns (address);
    function token1() external view returns (address);
}

contract FiveMinuteWSUSDCPrediction is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable tokenBet;      // USDC
    address public immutable tokenAsset;   // wS
    IRamsesV3Pool public immutable pool;   // wS/USDC Ramses V3 pool
    address public immutable owner;

    uint256 public constant MARKET_DURATION = 5 minutes;
    uint256 public constant MIN_BET = 5e5; // 0.5 USDC (USDC = 6 decimals)

    // Fee: 5% of losing pool
    uint256 public constant FEE_BPS = 500;
    uint256 public constant BPS_DENOMINATOR = 10000;
    address public constant FEE_WALLET = 0xA6d40605618bf9398BF406989d08cE314D47af59;

    struct Market {
        uint256 startPrice;   // USDC per wS, 1e18
        uint256 endPrice;     // USDC per wS, 1e18
        uint64 startTime;
        uint64 endTime;
        uint256 upPool;       // total USDC on "up"
        uint256 downPool;     // total USDC on "down"
        bool resolved;
        bool feeTaken;
    }

    struct Bet {
        uint256 amount;
        bool directionUp;
        bool claimed;
    }

    uint256 public nextMarketId;
    mapping(uint256 => Market) public markets;
    mapping(uint256 => mapping(address => Bet)) public bets;

    event MarketCreated(uint256 indexed marketId, uint256 startPrice, uint64 startTime, uint64 endTime);
    event MarketResolved(uint256 indexed marketId, uint256 endPrice);
    event BetPlaced(uint256 indexed marketId, address indexed user, uint256 amount, bool directionUp);
    event Claimed(uint256 indexed marketId, address indexed user, uint256 payout);
    event FeePaid(uint256 indexed marketId, uint256 amount);
    event RefundIssued(uint256 indexed marketId, address indexed user, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(
        address _tokenBet,
        address _tokenAsset,
        address _pool
    ) {
        owner = msg.sender;
        tokenBet = IERC20(_tokenBet);
        tokenAsset = _tokenAsset;
        pool = IRamsesV3Pool(_pool);

        address t0 = pool.token0();
        address t1 = pool.token1();
        require((t0 == _tokenAsset || t1 == _tokenAsset), "Pool missing wS");
        require((t0 == _tokenBet || t1 == _tokenBet), "Pool missing USDC");
    }

    // spot price of wS in USDC, scaled to 1e18
    function _getSpotPrice() internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = pool.slot0();
        uint256 sq = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        uint256 priceX96 = sq >> 192;
        return priceX96 * 1e18;
    }

    function createMarket() public onlyOwner returns (uint256 id) {
        uint256 startPrice = _getSpotPrice();

        id = nextMarketId++;
        Market storage m = markets[id];
        m.startPrice = startPrice;
        m.startTime = uint64(block.timestamp);
        m.endTime = uint64(block.timestamp + MARKET_DURATION);

        emit MarketCreated(id, startPrice, m.startTime, m.endTime);
    }

    function betUp(uint256 marketId, uint256 amount) external nonReentrant {
        _placeBet(marketId, amount, true);
    }

    function betDown(uint256 marketId, uint256 amount) external nonReentrant {
        _placeBet(marketId, amount, false);
    }

    function _placeBet(uint256 marketId, uint256 amount, bool directionUp) internal {
        Market storage m = markets[marketId];
        require(m.startTime != 0, "Market does not exist");
        require(block.timestamp < m.endTime, "Market ended");
        require(amount >= MIN_BET, "Bet too small");

        Bet storage b = bets[marketId][msg.sender];
        require(b.amount == 0, "Already bet");

        // pull USDC from user (uses SafeERC20)
        tokenBet.safeTransferFrom(msg.sender, address(this), amount);

        b.amount = amount;
        b.directionUp = directionUp;

        if (directionUp) {
            m.upPool += amount;
        } else {
            m.downPool += amount;
        }

        emit BetPlaced(marketId, msg.sender, amount, directionUp);
    }

    function resolveMarket(uint256 marketId) external onlyOwner {
        Market storage m = markets[marketId];
        require(m.startTime != 0, "Market does not exist");
        require(block.timestamp >= m.endTime, "Too early");
        require(!m.resolved, "Already resolved");

        uint256 endPrice = _getSpotPrice();
        m.endPrice = endPrice;
        m.resolved = true;

        emit MarketResolved(marketId, endPrice);

        // Owner-triggered auto creation
        createMarket();
    }

    /**
     * @notice Claim payout or refund for a market.
     *
     * Behavior:
     * - If there are winners (winnerPool > 0): winners receive proportional share of (totalPool - fee),
     *   where fee = 5% of loserPool and is sent to FEE_WALLET once.
     * - If winnerPool == 0 (no one bet on the winning side): all bettors on the losing side are refunded their stake.
     */
    function claim(uint256 marketId) external nonReentrant {
        Market storage m = markets[marketId];
        require(m.resolved, "Not resolved");

        Bet storage b = bets[marketId][msg.sender];
        require(b.amount > 0, "No bet");
        require(!b.claimed, "Already claimed");

        bool upWon = m.endPrice > m.startPrice;
        bool userWon = (upWon && b.directionUp) || (!upWon && !b.directionUp);

        uint256 totalPool = m.upPool + m.downPool;
        uint256 winnerPool = upWon ? m.upPool : m.downPool;
        uint256 loserPool = upWon ? m.downPool : m.upPool;

        uint256 payout;

        // Case: no winners (winnerPool == 0) -> refund losers their stake
        if (winnerPool == 0) {
            // In this scenario, everyone who bet is on the losing side (since winnerPool==0).
            // Refund the bettor their original amount.
            payout = b.amount;

            b.claimed = true;
            tokenBet.safeTransfer(msg.sender, payout);
            emit RefundIssued(marketId, msg.sender, payout);
            return;
        }

        // Normal case: there are winners
        require(userWon, "Lost bet");

        // Take fee once (from loser pool)
        if (!m.feeTaken) {
            uint256 feeAmount = (loserPool * FEE_BPS) / BPS_DENOMINATOR;
            m.feeTaken = true;
            if (feeAmount > 0) {
                tokenBet.safeTransfer(FEE_WALLET, feeAmount);
                emit FeePaid(marketId, feeAmount);
            }
            // distributable pool is total minus fee
            totalPool -= feeAmount;
        }

        // proportional payout from remaining pool
        // payout = b.amount * totalPool / winnerPool
        payout = (b.amount * totalPool) / winnerPool;

        b.claimed = true;
        tokenBet.safeTransfer(msg.sender, payout);

        emit Claimed(marketId, msg.sender, payout);
    }
}

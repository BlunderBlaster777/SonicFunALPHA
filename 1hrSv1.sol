// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

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

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from,address to,uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

contract FiveMinuteWSUSDCPrediction {
    IERC20 public immutable tokenBet;      // USDC
    address public immutable tokenAsset;   // wS
    IRamsesV3Pool public immutable pool;   // wS/USDC Ramses V3 pool
    address public immutable owner;

    uint256 public constant MARKET_DURATION = 5 minutes;

    struct Market {
        uint256 startPrice;   // USDC per wS, 1e18
        uint256 endPrice;     // USDC per wS, 1e18
        uint64 startTime;
        uint64 endTime;
        uint256 upPool;       // total USDC on "up"
        uint256 downPool;     // total USDC on "down"
        bool resolved;
    }

    struct Bet {
        uint256 amount;
        bool directionUp;
        bool claimed;
    }

    uint256 public nextMarketId;
    mapping(uint256 => Market) public markets;
    mapping(uint256 => mapping(address => Bet)) public bets;

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(
        address _tokenBet,      // USDC
        address _tokenAsset,    // wS
        address _pool           // Ramses V3 wS/USDC
    ) {
        owner = msg.sender;
        tokenBet = IERC20(_tokenBet);
        tokenAsset = _tokenAsset;
        pool = IRamsesV3Pool(_pool);

        // sanity: pool must contain tokenAsset (wS) and USDC
        address t0 = pool.token0();
        address t1 = pool.token1();
        require(
            (t0 == _tokenAsset || t1 == _tokenAsset),
            "Pool does not contain wS"
        );
        require(
            (t0 == _tokenBet || t1 == _tokenBet),
            "Pool does not contain USDC"
        );
    }

    // spot price of wS in USDC, scaled to 1e18
    function _getSpotPrice() internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = pool.slot0();
        // price = (sqrtPriceX96^2 / 2^192)
        uint256 sq = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        uint256 priceX96 = sq >> 192; // raw price (token1 per token0)

        // scale to 1e18 for nicer math
        return priceX96 * 1e18;
    }

    function createMarket() external onlyOwner returns (uint256 id) {
        uint256 startPrice = _getSpotPrice();

        id = nextMarketId++;
        Market storage m = markets[id];
        m.startPrice = startPrice;
        m.startTime = uint64(block.timestamp);
        m.endTime = uint64(block.timestamp + MARKET_DURATION);
    }

    function betUp(uint256 marketId, uint256 amount) external {
        _placeBet(marketId, amount, true);
    }

    function betDown(uint256 marketId, uint256 amount) external {
        _placeBet(marketId, amount, false);
    }

    function _placeBet(uint256 marketId, uint256 amount, bool directionUp) internal {
        Market storage m = markets[marketId];
        require(m.startTime != 0, "Market does not exist");
        require(block.timestamp < m.endTime, "Market ended");
        require(amount > 0, "Zero amount");

        Bet storage b = bets[marketId][msg.sender];
        require(b.amount == 0, "Already bet");

        // pull USDC from user
        require(tokenBet.transferFrom(msg.sender, address(this), amount), "Transfer failed");

        b.amount = amount;
        b.directionUp = directionUp;

        if (directionUp) {
            m.upPool += amount;
        } else {
            m.downPool += amount;
        }
    }

    function resolveMarket(uint256 marketId) external {
        Market storage m = markets[marketId];
        require(m.startTime != 0, "Market does not exist");
        require(block.timestamp >= m.endTime, "Too early");
        require(!m.resolved, "Already resolved");

        uint256 endPrice = _getSpotPrice();
        m.endPrice = endPrice;
        m.resolved = true;
    }

    function claim(uint256 marketId) external {
        Market storage m = markets[marketId];
        require(m.resolved, "Not resolved");

        Bet storage b = bets[marketId][msg.sender];
        require(b.amount > 0, "No bet");
        require(!b.claimed, "Already claimed");

        bool upWon = m.endPrice > m.startPrice;
        bool userWon = (upWon && b.directionUp) || (!upWon && !b.directionUp);
        require(userWon, "Lost bet");

        uint256 totalPool = m.upPool + m.downPool;
        uint256 winnerPool = upWon ? m.upPool : m.downPool;

        // proportional payout from total pool
        uint256 payout = (b.amount * totalPool) / winnerPool;

        b.claimed = true;
        require(tokenBet.transfer(msg.sender, payout), "Payout failed");
    }
}

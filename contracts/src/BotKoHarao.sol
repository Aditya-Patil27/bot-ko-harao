// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract BotKoHarao {

    struct Clue {
        address giver;
        uint32  round;
        uint16  group;
        bool    settled;
        bytes32 commit;
    }

    struct Settlement {
        bytes32   clueId;
        uint8     answer;
        bytes32   salt;
        address[] winners;
    }

    mapping(bytes32 => Clue) public clues;
    mapping(bytes32 => mapping(address => uint256)) public guessOf;
    mapping(address => uint256) public balanceOf;

    address[2] public bots;
    uint256 public R;
    uint256 public G;
    address public operator;

    event ClueGiven(bytes32 indexed clueId, address indexed giver, uint32 round, uint16 group, string text);
    event Guessed(bytes32 indexed clueId, address indexed player, uint8 choice, uint64 blockNo);
    event Settled(bytes32 indexed clueId, uint8 answer, uint8 humansRight, uint8 botsRightMask);
    event Paid(bytes32 indexed clueId, address indexed from, address indexed to, uint256 amount, uint8 reason);
    event Funded(address indexed from, address indexed bot, uint256 amount);

    uint8 constant REASON_GUESSER = 1;
    uint8 constant REASON_GIVER   = 2;

    constructor(address bot0, address bot1, uint256 r, uint256 g) {
        operator = msg.sender;
        bots[0] = bot0;
        bots[1] = bot1;
        R = r;
        G = g;
    }

    function postClue(uint32 round, uint16 group, bytes32 commit, string calldata text) external {
        bytes32 clueId = keccak256(abi.encode(msg.sender, round));
        require(clues[clueId].giver == address(0), "DUPE_CLUE");
        clues[clueId] = Clue({
            giver: msg.sender,
            round: round,
            group: group,
            settled: false,
            commit: commit
        });
        emit ClueGiven(clueId, msg.sender, round, group, text);
    }

    function guess(bytes32 clueId, uint8 choice) external {
        Clue storage c = clues[clueId];
        require(c.giver != address(0), "NO_CLUE");
        require(!c.settled, "SETTLED");
        require(msg.sender != c.giver, "OWN_CLUE");
        require(choice < 4, "BAD_CHOICE");
        require(guessOf[clueId][msg.sender] == 0, "DUPE_GUESS");
        guessOf[clueId][msg.sender] = (block.number << 8) | uint256(choice + 1);
        emit Guessed(clueId, msg.sender, choice, uint64(block.number));
    }

    function settle(Settlement[] calldata items) external {
        require(msg.sender == operator, "NOT_OP");
        for (uint256 i; i < items.length; ++i) {
            _settleOne(items[i]);
        }
    }

    function _settleOne(Settlement calldata item) internal {
        Clue storage c = clues[item.clueId];
        require(c.giver != address(0), "NO_CLUE");
        require(!c.settled, "SETTLED");
        require(
            keccak256(abi.encode(c.giver, c.round, item.answer, item.salt)) == c.commit,
            "BAD_COMMIT"
        );

        uint256[2] memory botBlock;
        for (uint256 b; b < 2; ++b) {
            uint256 g = guessOf[item.clueId][bots[b]];
            if (g != 0 && _choice(g) == item.answer) {
                botBlock[b] = _blk(g);
            } else {
                botBlock[b] = type(uint256).max;
            }
        }

        uint8 humansRight;
        uint8 botsRightMask;
        for (uint256 b; b < 2; ++b) {
            if (botBlock[b] != type(uint256).max) {
                botsRightMask |= uint8(1 << b);
            }
        }

        address prev;
        for (uint256 h; h < item.winners.length; ++h) {
            address winner = item.winners[h];
            require(winner > prev, "UNSORTED");
            require(winner != c.giver, "GIVER_WIN");
            require(winner != bots[0] && winner != bots[1], "BOT_WIN");

            uint256 g = guessOf[item.clueId][winner];
            require(g != 0 && _choice(g) == item.answer, "NOT_WINNER");

            uint256 winnerBlock = _blk(g);
            for (uint256 b; b < 2; ++b) {
                if (winnerBlock <= botBlock[b]) {
                    _pay(item.clueId, bots[b], winner, R, REASON_GUESSER);
                }
            }
            prev = winner;
            ++humansRight;
        }

        if (humansRight > 0) {
            for (uint256 b; b < 2; ++b) {
                if (botBlock[b] == type(uint256).max) {
                    _pay(item.clueId, bots[b], c.giver, G, REASON_GIVER);
                }
            }
        }

        c.settled = true;
        emit Settled(item.clueId, item.answer, humansRight, botsRightMask);
    }

    function _pay(bytes32 clueId, address from, address to, uint256 amount, uint8 reason) internal {
        uint256 bal = balanceOf[from];
        if (bal == 0) return;
        if (amount > bal) amount = bal;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Paid(clueId, from, to, amount, reason);
    }

    function fund(address bot) external payable {
        require(bot == bots[0] || bot == bots[1], "NOT_BOT");
        balanceOf[bot] += msg.value;
        emit Funded(msg.sender, bot, msg.value);
    }

    // Open to any sender: it only forwards the caller's own MON. Lets a separate
    // drip wallet fund burners without sharing the operator's nonce or reserve window.
    function dripMany(address[] calldata to, uint256 each) external payable {
        require(msg.value >= to.length * each, "LOW_VALUE");
        for (uint256 i; i < to.length; ++i) {
            (bool ok,) = to[i].call{value: each}("");
            require(ok, "DRIP_FAIL");
        }
    }

    function withdraw() external {
        require(msg.sender != bots[0] && msg.sender != bots[1], "BOT_NO_WD");
        uint256 amt = balanceOf[msg.sender];
        require(amt > 0, "NO_BAL");
        balanceOf[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        require(ok, "WD_FAIL");
    }

    function _choice(uint256 packed) internal pure returns (uint8) {
        return uint8((packed & 0xFF) - 1);
    }

    function _blk(uint256 packed) internal pure returns (uint256) {
        return packed >> 8;
    }

    receive() external payable {}
}

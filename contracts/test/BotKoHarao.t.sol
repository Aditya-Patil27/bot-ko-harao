// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/BotKoHarao.sol";

contract BotKoHaraoTest is Test {
    BotKoHarao game;

    address operator = address(this);
    address bot0     = address(0xB070);
    address bot1     = address(0xB071);
    address alice    = address(0xA11CE);
    address bob      = address(0xB0B);
    address carol    = address(0xCA201);

    uint256 constant R_VAL = 0.02 ether;
    uint256 constant G_VAL = 0.05 ether;

    function setUp() public {
        game = new BotKoHarao(bot0, bot1, R_VAL, G_VAL);
        game.fund{value: 5 ether}(bot0);
        game.fund{value: 5 ether}(bot1);
    }

    // --- helpers ---

    function _clueId(address giver, uint32 round) internal pure returns (bytes32) {
        return keccak256(abi.encode(giver, round));
    }

    function _commit(address giver, uint32 round, uint8 answer, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(giver, round, answer, salt));
    }

    function _postClue(address giver, uint32 round, uint8 answer, bytes32 salt) internal returns (bytes32) {
        bytes32 cid = _clueId(giver, round);
        bytes32 commit = _commit(giver, round, answer, salt);
        vm.prank(giver);
        game.postClue(round, 0, commit, "test clue");
        return cid;
    }

    function _guess(address player, bytes32 clueId, uint8 choice) internal {
        vm.prank(player);
        game.guess(clueId, choice);
    }

    function _settleOne(bytes32 clueId, uint8 answer, bytes32 salt, address[] memory winners) internal {
        BotKoHarao.Settlement[] memory items = new BotKoHarao.Settlement[](1);
        items[0] = BotKoHarao.Settlement(clueId, answer, salt, winners);
        game.settle(items);
    }

    // --- SCORING TABLE TESTS ---

    function test_beatBothBots() public {
        bytes32 salt = bytes32(uint256(1));
        uint8 answer = 0;
        bytes32 cid = _postClue(alice, 1, answer, salt);

        // Humans guess correctly in block 100
        vm.roll(100);
        _guess(bob, cid, answer);
        _guess(carol, cid, answer);

        // Bots guess WRONG in block 101
        vm.roll(101);
        _guess(bot0, cid, 2);
        _guess(bot1, cid, 3);

        address[] memory winners = new address[](2);
        winners[0] = bob;
        winners[1] = carol;
        _settleOne(cid, answer, salt, winners);

        // Each human beats both bots → 2R each
        assertEq(game.balanceOf(bob), 2 * R_VAL);
        assertEq(game.balanceOf(carol), 2 * R_VAL);
        // Giver gets G per wrong bot (both wrong, ≥1 human right) → 2G
        assertEq(game.balanceOf(alice), 2 * G_VAL);
    }

    function test_fasterThanBada() public {
        bytes32 salt = bytes32(uint256(2));
        uint8 answer = 1;
        bytes32 cid = _postClue(alice, 2, answer, salt);

        // Human guesses right in block 100
        vm.roll(100);
        _guess(bob, cid, answer);

        // Both bots guess right but later
        vm.roll(105);
        _guess(bot0, cid, answer);
        vm.roll(110);
        _guess(bot1, cid, answer);

        address[] memory winners = new address[](1);
        winners[0] = bob;
        _settleOne(cid, answer, salt, winners);

        // Bob beats both bots on speed → 2R
        assertEq(game.balanceOf(bob), 2 * R_VAL);
        // Both bots were right → giver gets 0
        assertEq(game.balanceOf(alice), 0);
    }

    function test_tooNiche() public {
        bytes32 salt = bytes32(uint256(3));
        uint8 answer = 2;
        bytes32 cid = _postClue(alice, 3, answer, salt);

        // Bots guess wrong
        vm.roll(100);
        _guess(bot0, cid, 0);
        _guess(bot1, cid, 1);
        // No humans guess right (bob guesses wrong)
        _guess(bob, cid, 3);

        // No winners
        address[] memory winners = new address[](0);
        _settleOne(cid, answer, salt, winners);

        // Nobody earns anything
        assertEq(game.balanceOf(bob), 0);
        assertEq(game.balanceOf(alice), 0);
    }

    function test_tooObvious() public {
        bytes32 salt = bytes32(uint256(4));
        uint8 answer = 0;
        bytes32 cid = _postClue(alice, 4, answer, salt);

        // Bot guesses right FAST (block 100)
        vm.roll(100);
        _guess(bot0, cid, answer);
        _guess(bot1, cid, answer);

        // Human guesses right but SLOWER (block 105)
        vm.roll(105);
        _guess(bob, cid, answer);

        address[] memory winners = new address[](1);
        winners[0] = bob;
        _settleOne(cid, answer, salt, winners);

        // Bob is slower than both bots → 0R
        assertEq(game.balanceOf(bob), 0);
        // Both bots right → giver gets 0
        assertEq(game.balanceOf(alice), 0);
    }

    function test_sameBlockHumanWins() public {
        bytes32 salt = bytes32(uint256(5));
        uint8 answer = 0;
        bytes32 cid = _postClue(alice, 5, answer, salt);

        // Same block — human and bot both guess right
        vm.roll(100);
        _guess(bob, cid, answer);
        _guess(bot0, cid, answer);
        _guess(bot1, cid, 3); // bot1 wrong

        address[] memory winners = new address[](1);
        winners[0] = bob;
        _settleOne(cid, answer, salt, winners);

        // Same block with bot0 → human wins (<=). Bot1 wrong → also wins.
        assertEq(game.balanceOf(bob), 2 * R_VAL);
        // Bot1 wrong + ≥1 human right → giver gets G
        assertEq(game.balanceOf(alice), G_VAL);
    }

    function test_botTimeout() public {
        bytes32 salt = bytes32(uint256(6));
        uint8 answer = 1;
        bytes32 cid = _postClue(alice, 6, answer, salt);

        // Human guesses right
        vm.roll(100);
        _guess(bob, cid, answer);
        // Bots don't guess at all (timeout)

        address[] memory winners = new address[](1);
        winners[0] = bob;
        _settleOne(cid, answer, salt, winners);

        // No bot guess = wrong. Bob beats both → 2R. Giver gets 2G.
        assertEq(game.balanceOf(bob), 2 * R_VAL);
        assertEq(game.balanceOf(alice), 2 * G_VAL);
    }

    // --- EDGE CASES ---

    function test_revert_wrongCommit() public {
        bytes32 salt = bytes32(uint256(7));
        bytes32 cid = _postClue(alice, 7, 0, salt);

        address[] memory winners = new address[](0);
        BotKoHarao.Settlement[] memory items = new BotKoHarao.Settlement[](1);
        items[0] = BotKoHarao.Settlement(cid, 1, salt, winners); // wrong answer
        vm.expectRevert("BAD_COMMIT");
        game.settle(items);
    }

    function test_revert_nonWinner() public {
        bytes32 salt = bytes32(uint256(8));
        uint8 answer = 0;
        bytes32 cid = _postClue(alice, 8, answer, salt);

        vm.roll(100);
        _guess(bob, cid, 3); // bob guessed WRONG

        address[] memory winners = new address[](1);
        winners[0] = bob;
        vm.expectRevert("NOT_WINNER");
        _settleOne(cid, answer, salt, winners);
    }

    function test_revert_unsortedWinners() public {
        bytes32 salt = bytes32(uint256(9));
        uint8 answer = 0;
        bytes32 cid = _postClue(alice, 9, answer, salt);

        vm.roll(100);
        _guess(bob, cid, answer);
        _guess(carol, cid, answer);

        // carol > bob in address, so [carol, bob] is unsorted
        address[] memory winners = new address[](2);
        if (carol > bob) {
            winners[0] = carol;
            winners[1] = bob;
        } else {
            winners[0] = bob;
            winners[1] = carol;
        }
        vm.expectRevert("UNSORTED");
        _settleOne(cid, answer, salt, winners);
    }

    function test_revert_giverGuessOwnClue() public {
        bytes32 salt = bytes32(uint256(10));
        bytes32 cid = _postClue(alice, 10, 0, salt);

        vm.roll(100);
        vm.prank(alice);
        vm.expectRevert("OWN_CLUE");
        game.guess(cid, 0);
    }

    function test_revert_doubleGuess() public {
        bytes32 salt = bytes32(uint256(11));
        bytes32 cid = _postClue(alice, 11, 0, salt);

        vm.roll(100);
        _guess(bob, cid, 0);
        vm.expectRevert("DUPE_GUESS");
        _guess(bob, cid, 1);
    }

    function test_revert_guessAfterSettle() public {
        bytes32 salt = bytes32(uint256(12));
        uint8 answer = 0;
        bytes32 cid = _postClue(alice, 12, answer, salt);

        address[] memory winners = new address[](0);
        _settleOne(cid, answer, salt, winners);

        vm.expectRevert("SETTLED");
        _guess(bob, cid, 0);
    }

    function test_revert_botWithdraw() public {
        vm.prank(bot0);
        vm.expectRevert("BOT_NO_WD");
        game.withdraw();
    }

    function test_partialPay_botBroke() public {
        // Deploy a game where bots have very little balance
        BotKoHarao small = new BotKoHarao(bot0, bot1, 1 ether, 1 ether);
        small.fund{value: 0.01 ether}(bot0);
        small.fund{value: 0.01 ether}(bot1);

        bytes32 salt = bytes32(uint256(13));
        uint8 answer = 0;
        bytes32 cid = _clueId(alice, 13);
        bytes32 commit = _commit(alice, 13, answer, salt);
        vm.prank(alice);
        small.postClue(13, 0, commit, "test");

        vm.roll(100);
        vm.prank(bob);
        small.guess(cid, answer);
        // Bots don't guess

        address[] memory winners = new address[](1);
        winners[0] = bob;
        BotKoHarao.Settlement[] memory items = new BotKoHarao.Settlement[](1);
        items[0] = BotKoHarao.Settlement(cid, answer, salt, winners);
        small.settle(items);

        // R=1 ether but bot only has 0.01, pays what it has
        // bob gets 0.01 from bot0 (R capped), then 0.01 from bot1
        assertEq(small.balanceOf(bob), 0.02 ether);
        // Giver: bots wrong + human right → G per bot, but bots are empty now
        assertEq(small.balanceOf(alice), 0);
    }

    function test_dupeClue_reverts() public {
        bytes32 salt = bytes32(uint256(14));
        _postClue(alice, 14, 0, salt);
        vm.expectRevert("DUPE_CLUE");
        _postClue(alice, 14, 0, salt);
    }

    function test_withdraw() public {
        bytes32 salt = bytes32(uint256(15));
        uint8 answer = 0;
        bytes32 cid = _postClue(alice, 15, answer, salt);

        vm.roll(100);
        _guess(bob, cid, answer);

        address[] memory winners = new address[](1);
        winners[0] = bob;
        _settleOne(cid, answer, salt, winners);

        uint256 bal = game.balanceOf(bob);
        assertGt(bal, 0);

        uint256 bobEthBefore = bob.balance;
        vm.prank(bob);
        game.withdraw();
        assertEq(game.balanceOf(bob), 0);
        assertEq(bob.balance, bobEthBefore + bal);
    }

    function test_dripMany() public {
        address[] memory targets = new address[](3);
        targets[0] = alice;
        targets[1] = bob;
        targets[2] = carol;
        uint256 each = 0.25 ether;

        uint256 aliceBefore = alice.balance;
        game.dripMany{value: 0.75 ether}(targets, each);
        assertEq(alice.balance, aliceBefore + each);
        assertEq(bob.balance, each);
        assertEq(carol.balance, each);
    }

    function test_dripMany_fromNonOperator() public {
        address dripper = makeAddr("dripper");
        vm.deal(dripper, 1 ether);
        address[] memory targets = new address[](2);
        targets[0] = alice;
        targets[1] = carol;

        uint256 aliceBefore = alice.balance;
        vm.prank(dripper);
        game.dripMany{value: 0.5 ether}(targets, 0.25 ether);
        assertEq(alice.balance, aliceBefore + 0.25 ether);
        assertEq(dripper.balance, 0.5 ether);
    }

    function test_revert_dripManyLowValue() public {
        address[] memory targets = new address[](2);
        targets[0] = alice;
        targets[1] = bob;
        vm.expectRevert("LOW_VALUE");
        game.dripMany{value: 0.25 ether}(targets, 0.25 ether);
    }

    function test_fund() public {
        uint256 before = game.balanceOf(bot0);
        game.fund{value: 1 ether}(bot0);
        assertEq(game.balanceOf(bot0), before + 1 ether);
    }

    function test_revert_fundNonBot() public {
        vm.expectRevert("NOT_BOT");
        game.fund{value: 1 ether}(alice);
    }

    function test_revert_settleNotOperator() public {
        BotKoHarao.Settlement[] memory items = new BotKoHarao.Settlement[](0);
        vm.prank(alice);
        vm.expectRevert("NOT_OP");
        game.settle(items);
    }

    function test_revert_badChoice() public {
        bytes32 salt = bytes32(uint256(16));
        bytes32 cid = _postClue(alice, 16, 0, salt);
        vm.roll(100);
        vm.prank(bob);
        vm.expectRevert("BAD_CHOICE");
        game.guess(cid, 4);
    }

    function test_giverInWinners_reverts() public {
        bytes32 salt = bytes32(uint256(17));
        uint8 answer = 0;
        bytes32 cid = _postClue(alice, 17, answer, salt);

        vm.roll(100);
        _guess(bob, cid, answer);

        address[] memory winners = new address[](1);
        winners[0] = alice;
        vm.expectRevert("GIVER_WIN");
        _settleOne(cid, answer, salt, winners);
    }

    receive() external payable {}
}
